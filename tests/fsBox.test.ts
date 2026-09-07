import { strict as assert } from "assert";
import { DEFAULT_BOX_CONFIG, FakeFsBox, type BoxTransport } from "../src/fsBox";
import type { ByteTransportRequest } from "../src/misc";

/**
 * A Box that has one vault folder (id 11) and, when told to, one file in it
 * (id 55, "a.md"). Metadata answers on the text transport, transfers on the
 * byte transport, exactly the split the adapter has to keep.
 */
function fakeBox(hasFile: boolean) {
  const bytes: ByteTransportRequest[] = [];
  const transport: BoxTransport = {
    text: async (params) => {
      const p = typeof params === "string" ? { url: params } : params;
      if (p.url.startsWith("https://api.box.com/2.0/folders/0/items"))
        return JSON.stringify({ entries: [{ id: "11", name: "Vault", type: "folder" }] });
      if (p.url.startsWith("https://api.box.com/2.0/folders/11/items"))
        return JSON.stringify({
          entries: hasFile ? [{ id: "55", name: "a.md", type: "file" }] : [],
        });
      throw new Error(`unexpected text call ${p.url}`);
    },
    bytes: async (req) => {
      bytes.push(req);
      return {
        status: req.method === "DELETE" ? 204 : req.method === "GET" ? 200 : 201,
        headers: {},
        arrayBuffer: new Uint8Array([7, 8, 9]).buffer,
        text: "",
      };
    },
  };
  const fs = new FakeFsBox(
    {
      ...DEFAULT_BOX_CONFIG,
      accessToken: "tok",
      refreshToken: "ref",
      accessTokenExpiresAtTimeMs: Date.now() + 3_600_000,
      remoteBaseDir: "Vault",
    },
    "Vault",
    async () => {},
    transport
  );
  return { fs, bytes };
}

describe("Box transfers travel on the app network layer", () => {
  it("uploads a new file as a hand-built multipart form with the parent folder id", async () => {
    const { fs, bytes } = fakeBox(false);
    const content = new Uint8Array([1, 2, 3, 4]).buffer;
    await fs.writeFile("a.md", content, 1000, 1000);

    const req = bytes.find((r) => r.url === "https://upload.box.com/api/2.0/files/content");
    assert.ok(req, "upload request");
    assert.equal(req!.method, "POST");
    assert.equal(req!.headers?.Authorization, "Bearer tok");
    assert.ok(req!.contentType?.startsWith("multipart/form-data; boundary="), req!.contentType);
    assert.equal(req!.throw, false);
    const body = new TextDecoder("latin1").decode(req!.body as ArrayBuffer);
    assert.ok(body.includes('name="attributes"'));
    assert.ok(body.includes('{"name":"a.md","parent":{"id":"11"}}'));
    assert.ok(body.includes('name="file"; filename="a.md"'));
    assert.ok(body.includes("\x01\x02\x03\x04\r\n--"), "file bytes precede the closing boundary");
  });

  it("uploads a new version against the existing file id", async () => {
    const { fs, bytes } = fakeBox(true);
    await fs.writeFile("a.md", new Uint8Array([9]).buffer, 1000, 1000);
    const req = bytes.find((r) => r.url === "https://upload.box.com/api/2.0/files/55/content");
    assert.ok(req, "new-version request");
    const body = new TextDecoder("latin1").decode(req!.body as ArrayBuffer);
    assert.ok(!body.includes('name="attributes"'), "a new version carries no attributes part");
  });

  it("downloads and deletes through the same transport", async () => {
    const { fs, bytes } = fakeBox(true);
    const content = await fs.readFile("a.md");
    assert.deepEqual([...new Uint8Array(content)], [7, 8, 9]);
    assert.equal(bytes[0].url, "https://api.box.com/2.0/files/55/content");
    assert.equal(bytes[0].method, "GET");

    await fs.rm("a.md");
    assert.equal(bytes[1].url, "https://api.box.com/2.0/files/55");
    assert.equal(bytes[1].method, "DELETE");
  });

  it("names the failing operation and status instead of a bare exception", async () => {
    const { fs } = fakeBox(false);
    const forbidden: BoxTransport = {
      text: async () => JSON.stringify({ entries: [{ id: "11", name: "Vault", type: "folder" }] }),
      bytes: async () => ({ status: 403, headers: {}, arrayBuffer: new ArrayBuffer(0), text: "" }),
    };
    const failing = new FakeFsBox(
      { ...DEFAULT_BOX_CONFIG, accessToken: "tok", refreshToken: "ref",
        accessTokenExpiresAtTimeMs: Date.now() + 3_600_000, remoteBaseDir: "Vault" },
      "Vault", async () => {}, forbidden);
    await assert.rejects(
      () => failing.writeFile("a.md", new ArrayBuffer(1), 1, 1),
      /upload new file failed: 403/
    );
    void fs;
  });
});
