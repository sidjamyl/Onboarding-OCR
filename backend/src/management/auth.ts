import { betterAuth, type BetterAuthOptions } from "better-auth";
import type { AppConfig } from "../config.js";

export function createAdminAuth(config: AppConfig, database: BetterAuthOptions["database"]) {
  if (!config.BETTER_AUTH_SECRET) throw new Error("BETTER_AUTH_SECRET is required to enable administration");
  return betterAuth({
    appName: "OCR Onboarding",
    secret: config.BETTER_AUTH_SECRET,
    baseURL: config.PUBLIC_BASE_URL,
    basePath: "/api/auth",
    database,
    trustedOrigins: [config.PUBLIC_BASE_URL],
    emailAndPassword: { enabled: true, disableSignUp: true, minPasswordLength: 12 },
    user: {
      modelName: "onboarding_auth_user",
      additionalFields: { isAdmin: { type: "boolean", defaultValue: false, input: false } },
    },
    session: { modelName: "onboarding_auth_session", expiresIn: 8 * 60 * 60, updateAge: 60 * 60 },
    account: { modelName: "onboarding_auth_account" },
    verification: { modelName: "onboarding_auth_verification" },
    rateLimit: { enabled: true, window: 60, max: 30, storage: "database" },
    advanced: {
      cookiePrefix: "ocr-admin",
      useSecureCookies: new URL(config.PUBLIC_BASE_URL).protocol === "https:",
      ipAddress: { ipAddressHeaders: ["x-onboarding-auth-ip"] },
    },
  });
}
export type AdminAuth = ReturnType<typeof createAdminAuth>;

export function emptyAuthTables() {
  return {
    onboarding_auth_user: [],
    onboarding_auth_session: [],
    onboarding_auth_account: [],
    onboarding_auth_verification: [],
    rateLimit: [],
  };
}

/** Server-only provisioning: no public sign-up or bootstrap HTTP endpoint. */
export async function provisionAdministrator(auth: AdminAuth, email: string, password: string) {
  if (password.length < 12) throw new Error("Use a password containing at least 12 characters");
  const context = await auth.$context;
  if (await context.internalAdapter.findUserByEmail(email.toLowerCase()))
    throw new Error("This administrator already exists");
  const hash = await context.password.hash(password);
  const user = await context.internalAdapter.createUser(
    { email: email.toLowerCase(), name: "Administrator", emailVerified: true, isAdmin: true },
    { method: "email-password" },
  );
  await context.internalAdapter.linkAccount({
    userId: user.id,
    accountId: user.id,
    providerId: "credential",
    password: hash,
  });
  return user;
}
