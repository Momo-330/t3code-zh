import * as fs from "node:fs";
const exe = process.env.TEMP + "\\t3-verify\\t3.exe";
const buf = fs.readFileSync(exe);
// app-update.yml is a plain text file; search for its provider marker in the archive.
const needle = Buffer.from("provider: github");
const idx = buf.indexOf(needle);
if (idx < 0) {
  console.log("app-update.yml NOT FOUND (searched for 'provider: github')");
  // Also look for the owner to be sure.
  const owner = buf.indexOf(Buffer.from("Momo-330"));
  console.log("owner string present:", owner >= 0);
} else {
  const start = Math.max(0, idx - 200);
  const end = Math.min(buf.length, idx + 320);
  console.log("FOUND at offset", idx);
  console.log(buf.slice(start, end).toString("utf8").replaceAll("\0", ""));
}
