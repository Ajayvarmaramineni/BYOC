import crypto from "node:crypto";

export interface SigV4Options {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service?: string;
}

export interface SignRequestParams {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: Uint8Array | string;
  /** Precomputed payload hash, including the SigV4 `UNSIGNED-PAYLOAD` sentinel. */
  payloadHash?: string;
  datetime?: Date;
}

export interface PresignUrlOptions {
  method?: string;
  expiresInSeconds?: number;
  datetime?: Date;
}

export function rfc3986UriEncode(str: string, encodeSlash: boolean = false): string {
  let result = encodeURIComponent(str).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  if (!encodeSlash) {
    result = result.replace(/%2F/g, "/");
  }
  return result;
}

function sha256Hex(data: string | NodeJS.ArrayBufferView): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function hmacSha256(key: string | NodeJS.ArrayBufferView, data: string): Buffer {
  return crypto.createHmac("sha256", key).update(data).digest();
}

function getSignatureKey(key: string, dateStamp: string, regionName: string, serviceName: string): Buffer {
  const kDate = hmacSha256("AWS4" + key, dateStamp);
  const kRegion = hmacSha256(kDate, regionName);
  const kService = hmacSha256(kRegion, serviceName);
  const kSigning = hmacSha256(kService, "aws4_request");
  return kSigning;
}

/**
 * Builds standard RFC 3986 canonical query string sorted by encoded parameter key.
 */
export function buildCanonicalQueryString(url: URL): string {
  const params: Array<[string, string]> = [];
  url.searchParams.forEach((value, key) => {
    params.push([rfc3986UriEncode(key, true), rfc3986UriEncode(value, true)]);
  });

  // Sort by encoded key first, then encoded value
  params.sort(([k1, v1], [k2, v2]) => {
    if (k1 === k2) return v1.localeCompare(v2);
    return k1.localeCompare(k2);
  });

  return params.map(([k, v]) => `${k}=${v}`).join("&");
}

/**
 * Signs HTTP requests for S3 and S3-compatible endpoints using AWS Signature Version 4.
 */
export function signS3Request(
  options: SigV4Options,
  params: SignRequestParams
): Record<string, string> {
  const service = options.service || "s3";
  const now = params.datetime || new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.substring(0, 8);

  const parsedUrl = new URL(params.url);
  const host = parsedUrl.host;
  const canonicalUri = parsedUrl.pathname || "/";
  const canonicalQuery = buildCanonicalQueryString(parsedUrl);

  const bodyHash = params.payloadHash ?? (
    params.body !== undefined
      ? sha256Hex(params.body)
      : "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
  );

  // Normalize all incoming headers to lowercase keys and trimmed values
  const normalizedHeaders: Record<string, string> = {
    host,
    "x-amz-date": amzDate,
    "x-amz-content-sha256": bodyHash
  };

  if (params.headers) {
    for (const [key, val] of Object.entries(params.headers)) {
      if (val !== undefined && val !== null) {
        normalizedHeaders[key.toLowerCase().trim()] = val.trim().replace(/\s+/g, " ");
      }
    }
  }

  const sortedHeaderKeys = Object.keys(normalizedHeaders).sort();
  const canonicalHeaders = sortedHeaderKeys.map((k) => `${k}:${normalizedHeaders[k]}\n`).join("");
  const signedHeaders = sortedHeaderKeys.join(";");

  const canonicalRequest = [
    params.method.toUpperCase(),
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    bodyHash
  ].join("\n");

  const credentialScope = `${dateStamp}/${options.region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest)
  ].join("\n");

  const signingKey = getSignatureKey(options.secretAccessKey, dateStamp, options.region, service);
  const signature = crypto.createHmac("sha256", signingKey).update(stringToSign).digest("hex");

  const authorizationHeader = `AWS4-HMAC-SHA256 Credential=${options.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    ...normalizedHeaders,
    Authorization: authorizationHeader
  };
}

/**
 * Creates an AWS SigV4 Presigned URL (query authenticated) for GET/PUT operations.
 */
export function createPresignedS3Url(
  options: SigV4Options,
  urlStr: string,
  presignOptions: PresignUrlOptions = {}
): string {
  const service = options.service || "s3";
  const now = presignOptions.datetime || new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.substring(0, 8);
  const expiresIn = presignOptions.expiresInSeconds || 3600;
  const method = (presignOptions.method || "GET").toUpperCase();

  const parsedUrl = new URL(urlStr);
  const host = parsedUrl.host;
  const canonicalUri = parsedUrl.pathname || "/";
  const credentialScope = `${dateStamp}/${options.region}/${service}/aws4_request`;

  parsedUrl.searchParams.set("X-Amz-Algorithm", "AWS4-HMAC-SHA256");
  parsedUrl.searchParams.set("X-Amz-Credential", `${options.accessKeyId}/${credentialScope}`);
  parsedUrl.searchParams.set("X-Amz-Date", amzDate);
  parsedUrl.searchParams.set("X-Amz-Expires", String(expiresIn));
  parsedUrl.searchParams.set("X-Amz-SignedHeaders", "host");

  const canonicalQuery = buildCanonicalQueryString(parsedUrl);
  const canonicalHeaders = `host:${host}\n`;
  const signedHeaders = "host";
  const bodyHash = "UNSIGNED-PAYLOAD";

  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    bodyHash
  ].join("\n");

  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest)
  ].join("\n");

  const signingKey = getSignatureKey(options.secretAccessKey, dateStamp, options.region, service);
  const signature = crypto.createHmac("sha256", signingKey).update(stringToSign).digest("hex");

  parsedUrl.searchParams.set("X-Amz-Signature", signature);
  return parsedUrl.toString();
}
