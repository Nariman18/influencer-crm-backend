import dotenv from "dotenv";
import path from "path";

const envName = process.env.RUN_ENV_FILE || ".env";
const explicit = (() => {
  // Prefer explicit .env.server/.env.worker
  if (process.env.ENV_FILE) return process.env.ENV_FILE;
  if (process.env.NODE_APP_INSTANCE === "worker") return ".env.worker";
  return process.env.ENV || ".env";
})();

const envPath = path.resolve(process.cwd(), explicit || envName);

const result = dotenv.config({ path: envPath });

if (result.error) {
  console.warn(
    `[env] Warning: failed to load ${envPath} — fallback to process.env variables if provided`
  );
} else {
  console.log(`[env] Loaded env from ${envPath}`);
}

if (!process.env.DATABASE_URL) {
  console.warn(
    "[env] DATABASE_URL is NOT set (process.env.DATABASE_URL undefined)"
  );
} else {
  console.log(
    "[env] DATABASE_URL prefix:",
    String(process.env.DATABASE_URL).slice(0, 80)
  );
}
