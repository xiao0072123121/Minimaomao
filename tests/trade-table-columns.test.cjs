const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");

function headersBefore(bodyId) {
  const bodyIndex = html.indexOf(`<tbody id="${bodyId}"`);
  assert.notEqual(bodyIndex, -1, `missing table body for ${bodyId}`);
  const headStart = html.lastIndexOf("<thead><tr>", bodyIndex);
  const headEnd = html.indexOf("</tr></thead>", headStart);
  const match = headStart >= 0 && headEnd >= 0
    ? [null, html.slice(headStart + "<thead><tr>".length, headEnd)]
    : null;
  assert.ok(match, `missing table for ${bodyId}`);
  return [...match[1].matchAll(/<th>(.*?)<\/th>/g)].map((item) => item[1]);
}

test("current positions omit the current/close price column", () => {
  const headers = headersBefore("simulation-open-body");
  assert.equal(headers.length, 12);
  assert.ok(!headers.includes("当前/平仓价"));
  assert.ok(!headers.includes("平仓价"));
  assert.match(html, /id="simulation-open-body"><tr class="empty-row"><td colspan="12">/);
});

test("closed trades label the stored exit price as close price", () => {
  const headers = headersBefore("simulation-closed-body");
  assert.equal(headers.length, 12);
  assert.equal(headers[4], "平仓价");
  assert.ok(!headers.includes("当前/平仓价"));
});
