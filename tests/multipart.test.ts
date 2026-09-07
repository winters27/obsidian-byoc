import { strict as assert } from "assert";
import { buildMultipartBody, retryRequestUrl } from "../src/misc";

describe("multipart body for byte transports", () => {
  it("frames a text field and a binary file the way a form would", () => {
    const bytes = new Uint8Array([0, 255, 13, 10, 45, 45, 7]).buffer;
    const { body, contentType } = buildMultipartBody(
      [
        { name: "attributes", value: '{"name":"a.md","parent":{"id":"0"}}' },
        { name: "file", value: bytes, filename: 'we"ird.md' },
      ],
      "BOUNDARY"
    );
    assert.equal(contentType, "multipart/form-data; boundary=BOUNDARY");

    const text = new TextDecoder("latin1").decode(body);
    const expectedHead =
      "--BOUNDARY\r\n" +
      'Content-Disposition: form-data; name="attributes"\r\n' +
      "\r\n" +
      '{"name":"a.md","parent":{"id":"0"}}\r\n' +
      "--BOUNDARY\r\n" +
      'Content-Disposition: form-data; name="file"; filename="we%22ird.md"\r\n' +
      "Content-Type: application/octet-stream\r\n" +
      "\r\n";
    assert.ok(text.startsWith(expectedHead), "part headers");
    assert.ok(text.endsWith("\r\n--BOUNDARY--\r\n"), "closing boundary");

    // The binary part is copied byte for byte, CRLF and dashes included.
    const fileStart = expectedHead.length;
    const fileBytes = new Uint8Array(body, fileStart, 7);
    assert.deepEqual([...fileBytes], [0, 255, 13, 10, 45, 45, 7]);
  });

  it("retries a 429 with backoff and returns any other status as is", async () => {
    const statuses = [429, 403];
    const calls: string[] = [];
    const transport = async (req: { url: string; throw?: boolean }) => {
      calls.push(`${req.url}:${req.throw}`);
      return {
        status: statuses.shift() ?? 200,
        headers: { "retry-after": "0" },
        arrayBuffer: new ArrayBuffer(0),
        text: "",
      };
    };
    const resp = await retryRequestUrl(transport, { url: "https://x.test/up" }, "box");
    assert.equal(resp.status, 403);
    assert.deepEqual(calls, ["https://x.test/up:false", "https://x.test/up:false"]);
  });
});
