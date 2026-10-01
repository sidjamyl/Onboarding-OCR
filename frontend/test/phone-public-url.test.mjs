import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";
import { publicUrl, requestOrigin } from "../src/lib/public-url.ts";

test("configured public origin keeps internal HTTPS proxy ports out of phone links", () => {
 const request = new Request("http://localhost:3000/api/demo/session", {
  headers: {host: "public.example.test:3000", "x-forwarded-proto": "https"},
 });
 assert.equal(publicUrl("/s/synthetic", request, "https://public.example.test"), "https://public.example.test/s/synthetic");
});

test("local desktop requests still advertise the configured phone origin", () => {
 const request = new Request("http://localhost:3000/api/onboarding/public/sessions/synthetic/transfer");
 assert.equal(publicUrl("/transfer/synthetic", request, "https://public.example.test/"), "https://public.example.test/transfer/synthetic");
});

test("unconfigured deployments use the forwarded public host and protocol", () => {
 const request = new Request("http://localhost:3000/api/demo/session", {
  headers: {host: "localhost:3000", "x-forwarded-host": "public.example.test, internal.example.test", "x-forwarded-proto": "https, http"},
 });
 assert.equal(publicUrl("/transfer/synthetic", request, ""), "https://public.example.test/transfer/synthetic");
});

test("direct requests retain their origin for the demo origin guard", () => {
 const request = new Request("http://localhost:3000/api/demo/session", {headers: {origin: "http://localhost:3000"}});
 assert.equal(requestOrigin(request), "http://localhost:3000");
});

test("phone QR preserves the server's public HTTPS transfer address when desktop uses localhost", () => {
 const source=readFileSync(new URL("../src/app/s/[token]/desktop-journey.tsx",import.meta.url),"utf8");
 const expression=source.match(/QRCode\.toDataURL\((.+), \{ margin: 1, width: 240 \}\)/)?.[1];
 assert.ok(expression);
 const payload={transferUrl:"https://public.example.test/transfer/synthetic"};
 const value=new Function("window","url","payload","return " + expression)({location:{origin:"http://localhost:3000"}},new URL(payload.transferUrl),payload);
 assert.equal(value,payload.transferUrl);
});
