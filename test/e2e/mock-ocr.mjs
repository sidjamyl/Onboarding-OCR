import { createServer } from "node:http";

const response = {
  fields: {
    last_name_latin: "BENALI",
    first_name_latin: "AMINE",
    last_name_arabic: "بن علي",
    first_name_arabic: "أمين",
    nin: "100012345678901234",
    document_number: "A123456",
    date_of_birth: "1990-02-12",
    expiry_date: "2035-02-12",
  },
  unreadableFields: [],
};

createServer((request, reply) => {
  if (request.url === "/readyz") {
    reply.writeHead(200, { "content-type": "application/json" });
    reply.end('{"status":"ready"}');
    return;
  }
  if (request.method === "POST" && request.url?.startsWith("/v1/verify/")) {
    request.resume();
    request.on("end", () => {
      reply.writeHead(200, { "content-type": "application/json" });
      reply.end(JSON.stringify({ verified: true, document: request.url.slice("/v1/verify/".length) }));
    });
    return;
  }
  if (request.method === "POST" && request.url?.startsWith("/v1/extract")) {
    request.resume();
    request.on("end", () => {
      reply.writeHead(200, { "content-type": "application/json" });
      reply.end(JSON.stringify(request.url.startsWith("/v1/extract-pair/")
        ? { mergedFields: response.fields, front: { fields: response.fields }, back: { fields: response.fields }, unreadableFields: [] }
        : response));
    });
    return;
  }
  reply.writeHead(404, { "content-type": "application/json" });
  reply.end('{"error":"not_found"}');
}).listen(18080, "0.0.0.0", () => console.info("Mock OCR listening on 18080"));
