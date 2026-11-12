import { appendFileSync, readFileSync } from "node:fs";

const API = "https://chromewebstore.googleapis.com";
const UPLOAD_POLL_MS = 5000;
const UPLOAD_WAIT_MS = 5 * 60 * 1000;

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const token = required("CWS_ACCESS_TOKEN");
const publisher = required("CWS_PUBLISHER_ID");
const item = required("CWS_EXTENSION_ID");
const zip = required("CWS_ZIP");
const version = JSON.parse(readFileSync("src/extension/manifest.json", "utf8")).version;
const name = `publishers/${publisher}/items/${item}`;

function summary(line) {
  console.log(line);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
}

async function call(method, url, body, headers = {}) {
  const response = await fetch(url, { method, body, headers: { authorization: `Bearer ${token}`, ...headers } });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${url.replace(API, "")} answered ${response.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

function versionParts(value) {
  return String(value).split(".").map(Number);
}

function newer(a, b) {
  const left = versionParts(a);
  const right = versionParts(b);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff) return diff > 0;
  }
  return false;
}

function channelVersions(revision) {
  return (revision?.distributionChannels ?? []).map((channel) => channel.crxVersion).filter(Boolean);
}

const fetchStatus = () => call("GET", `${API}/v2/${name}:fetchStatus`);

const status = await fetchStatus();
const published = channelVersions(status.publishedItemRevisionStatus);
const submitted = channelVersions(status.submittedItemRevisionStatus);
const known = [...published, ...submitted];
if (known.some((seen) => seen === version || newer(seen, version))) {
  summary(`Chrome Web Store already has extension ${version} or newer (published: ${published.join(", ") || "none"}; submitted: ${submitted.join(", ") || "none"}). Nothing to upload.`);
  process.exit(0);
}
const pending = status.submittedItemRevisionStatus?.state;
if (pending === "PENDING_REVIEW" || pending === "STAGED") {
  throw new Error(`Extension ${submitted.join(", ")} is still ${pending === "STAGED" ? "approved and waiting for you to publish it" : "in review"} on the Chrome Web Store. Publish or cancel it in the developer dashboard, then run this workflow again.`);
}

let upload = await call("POST", `${API}/upload/v2/${name}:upload`, readFileSync(zip), { "content-type": "application/zip" });
const deadline = Date.now() + UPLOAD_WAIT_MS;
while (upload.uploadState === "IN_PROGRESS" || upload.uploadState === "UPLOAD_IN_PROGRESS") {
  if (Date.now() > deadline) throw new Error("The Chrome Web Store did not finish processing the upload in 5 minutes.");
  await new Promise((resolve) => setTimeout(resolve, UPLOAD_POLL_MS));
  const state = (await fetchStatus()).lastAsyncUploadState;
  upload = { ...upload, uploadState: state === "SUCCEEDED" || state === "FAILED" ? state : "IN_PROGRESS" };
}
if (upload.uploadState !== "SUCCEEDED") throw new Error(`The Chrome Web Store upload ended as ${upload.uploadState}: ${JSON.stringify(upload)}`);
console.log(`Uploaded extension ${upload.crxVersion ?? version}.`);

const result = await call("POST", `${API}/v2/${name}:publish`, JSON.stringify({ publishType: "STAGED_PUBLISH" }), { "content-type": "application/json" });
for (const warning of result.warningInfo?.warnings ?? []) console.log(`warning: ${warning.reason}: ${warning.description}`);
summary(`Extension ${version} is submitted to the Chrome Web Store (state: ${result.state ?? "unknown"}). After review it waits as staged: publish it in the developer dashboard.`);
