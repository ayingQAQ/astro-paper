import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { TOTP, Secret } from "otpauth";
import { atomicWrite, HttpError } from "./content.mjs";
const scrypt = promisify(scryptCallback);
export async function initializeAdmin(data, password) {
  if (
    typeof password !== "string" ||
    password.length < 12 ||
    password.length > 256
  )
    throw new Error("管理员密码需要 12–256 个字符");
  const salt = randomBytes(32).toString("hex");
  const key = (await scrypt(password, salt, 64)).toString("hex");
  let previous = {};
  try {
    previous = JSON.parse(
      await readFile(path.join(data, "admin.json"), "utf8")
    );
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  await atomicWrite(
    path.join(data, "admin.json"),
    JSON.stringify({ ...previous, salt, key })
  );
}
export async function resetTotp(data) {
  const file = path.join(data, "admin.json");
  const admin = JSON.parse(await readFile(file, "utf8"));
  delete admin.totp;
  await atomicWrite(file, JSON.stringify(admin));
}
function otp(secret) {
  return new TOTP({
    issuer: "Wenying",
    label: "管理员",
    secret,
    digits: 6,
    period: 30,
    algorithm: "SHA1",
  });
}
export class Auth {
  constructor(data) {
    this.data = data;
    this.sessions = new Map();
    this.attempts = [];
    this.queue = Promise.resolve();
  }
  serial(fn) {
    const result = this.queue.then(fn);
    this.queue = result.catch(() => {});
    return result;
  }
  read() {
    return readFile(path.join(this.data, "admin.json"), "utf8").then(
      JSON.parse
    );
  }
  write(admin) {
    return atomicWrite(
      path.join(this.data, "admin.json"),
      JSON.stringify(admin)
    );
  }
  async status() {
    return { enabled: Boolean((await this.read()).totp) };
  }
  limit() {
    const now = Date.now();
    this.attempts = this.attempts.filter(time => now - time < 15 * 60 * 1000);
    if (this.attempts.length >= 10)
      throw new HttpError(429, "登录尝试过多，请 15 分钟后重试");
    this.attempts.push(now);
  }
  async checkPassword(admin, password, status = 401) {
    if (typeof password !== "string" || password.length > 256)
      throw new HttpError(status, "密码不正确");
    const { salt, key } = admin;
    const actual = await scrypt(password, salt, 64);
    if (!timingSafeEqual(actual, Buffer.from(key, "hex")))
      throw new HttpError(status, "密码不正确");
  }
  checkCode(config, code, status = 401) {
    const now = Date.now();
    const delta =
      typeof code === "string" && /^\d{6}$/.test(code)
        ? otp(config.secret).validate({
            token: code,
            timestamp: now,
            window: 1,
          })
        : null;
    const step = Math.floor(now / 30000) + delta;
    if (delta === null || step <= (config.lastStep ?? -1))
      throw new HttpError(
        status,
        "验证码无效或已使用，请输入验证器中新的 6 位数字"
      );
    return step;
  }
  active(session) {
    if (
      this.sessions.get(session?.token) !== session ||
      session.expires <= Date.now()
    )
      throw new HttpError(401, "请重新登录");
  }
  beginSetup(session, password) {
    return this.serial(async () => {
      this.active(session);
      this.limit();
      const admin = await this.read();
      await this.checkPassword(admin, password, 400);
      if (admin.totp)
        throw new HttpError(409, "请先关闭当前验证器，再绑定新设备");
      const secret = new Secret({ size: 20 }).base32;
      session.pendingTotp = { secret, expires: Date.now() + 10 * 60000 };
      return { secret, uri: otp(secret).toString() };
    });
  }
  confirmSetup(session, code) {
    return this.serial(async () => {
      this.active(session);
      this.limit();
      const pending = session.pendingTotp;
      if (!pending || pending.expires <= Date.now()) {
        delete session.pendingTotp;
        throw new HttpError(400, "绑定已过期，请重新生成二维码");
      }
      const admin = await this.read();
      if (admin.totp) throw new HttpError(409, "验证器已启用");
      admin.totp = {
        secret: pending.secret,
        lastStep: this.checkCode(pending, code, 400),
      };
      await this.write(admin);
      this.sessions.clear();
      this.attempts = [];
      return { ok: true };
    });
  }
  disable(password, code, session) {
    return this.serial(async () => {
      if (session) this.active(session);
      this.limit();
      const admin = await this.read();
      await this.checkPassword(admin, password, 400);
      if (!admin.totp) throw new HttpError(400, "尚未启用验证器");
      this.checkCode(admin.totp, code, 400);
      delete admin.totp;
      await this.write(admin);
      this.sessions.clear();
      this.attempts = [];
      return { ok: true };
    });
  }
  login(password, code) {
    return this.serial(async () => {
      this.limit();
      const admin = await this.read();
      await this.checkPassword(admin, password);
      if (admin.totp) {
        if (code === undefined || code === "") return { requiresTotp: true };
        admin.totp.lastStep = this.checkCode(admin.totp, code);
        await this.write(admin);
      }
      const now = Date.now();
      this.attempts = [];
      for (const [token, value] of this.sessions)
        if (value.expires < now) this.sessions.delete(token);
      if (this.sessions.size >= 10)
        this.sessions.delete(this.sessions.keys().next().value);
      const token = randomBytes(32).toString("hex");
      const session = {
        token,
        csrf: randomBytes(32).toString("hex"),
        expires: now + 12 * 60 * 60 * 1000,
      };
      this.sessions.set(token, session);
      return session;
    });
  }
  get(req) {
    const token = (req.headers.cookie ?? "")
      .split(";")
      .map(v => v.trim())
      .find(v => v.startsWith("wenying_session="))
      ?.slice("wenying_session=".length);
    const session = this.sessions.get(token);
    if (!session || session.expires < Date.now()) {
      this.sessions.delete(token);
      throw new HttpError(401, "请先登录");
    }
    return session;
  }
}
