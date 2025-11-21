// src/lib/gcs-client.ts
import { Storage } from "@google-cloud/storage";

/**
 * Parse a possibly-escaped JSON service account string.
 * Accepts either:
 *  raw JSON
 *  SON with escaped newlines inside private_key (\\n)
 */
function parseMaybeEscapedJson(raw?: string) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (e) {
    // Try replacing escaped newlines then parse
    try {
      const cleaned = raw.replace(/\\n/g, "\n");
      return JSON.parse(cleaned);
    } catch (e2) {
      // Not parseable
      console.error("[gcs-client] failed to parse GOOGLE_SERVICE_ACCOUNT:", e2);
      return null;
    }
  }
}

/**
 * Returns a configured Google Cloud Storage client.
 *
 * Priority:
 * 1) GOOGLE_SERVICE_ACCOUNT or GOOGLE_APPLICATION_CREDENTIALS_JSON
 * 2) GOOGLE_APPLICATION_CREDENTIALS -> dev
 * 3) Application Default Credentials -> GCP environment
 */
export function getGcsClient(): Storage {
  // env var names we accept (Render: paste JSON here)
  const jsonEnv =
    process.env.GOOGLE_SERVICE_ACCOUNT ??
    process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;

  if (jsonEnv) {
    const creds = parseMaybeEscapedJson(jsonEnv);
    if (creds && creds.client_email && creds.private_key) {
      // ensure private_key newlines are correct
      const privateKey = (creds.private_key as string).includes("\\n")
        ? (creds.private_key as string).replace(/\\n/g, "\n")
        : (creds.private_key as string);

      const projectId = process.env.GOOGLE_CLOUD_PROJECT_ID || creds.project_id;

      return new Storage({
        projectId,
        credentials: {
          client_email: creds.client_email,
          private_key: privateKey,
        },
      });
    } else {
      console.warn(
        "[gcs-client] GOOGLE_SERVICE_ACCOUNT present but invalid (missing client_email/private_key). Falling back."
      );
    }
  }

  // If you have a file path (local dev), let the Storage client read it
  const keyFilePath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (keyFilePath && keyFilePath.length > 0) {
    return new Storage({
      keyFilename: keyFilePath,
      projectId: process.env.GOOGLE_CLOUD_PROJECT_ID,
    });
  }

  // Fallback to ADC (useful on GCP infra where the instance has an attached SA)
  return new Storage({
    projectId: process.env.GOOGLE_CLOUD_PROJECT_ID,
  });
}
