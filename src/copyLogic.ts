import type { FakeFs } from "./fsAll";

export async function copyFolder(key: string, left: FakeFs, right: FakeFs) {
  if (!key.endsWith("/")) {
    throw Error(`should not call ${key} in copyFolder`);
  }
  const statsLeft = await left.stat(key);
  const entity = await right.mkdir(key, statsLeft.mtimeCli);
  return {
    entity: entity,
    content: undefined,
  };
}

export async function copyFile(key: string, left: FakeFs, right: FakeFs) {
  // console.debug(`copyFile: key=${key}, left=${left.kind}, right=${right.kind}`);
  if (key.endsWith("/")) {
    throw Error(`should not call ${key} in copyFile`);
  }
  const statsLeft = await left.stat(key);
  const content = await left.readFile(key);

  if (statsLeft.size === undefined || statsLeft.size === 0) {
    // some weird bugs on android not returning size. just ignore them
    statsLeft.size = content.byteLength;
  } else {
    if (statsLeft.size !== content.byteLength) {
      throw Error(
        `error copying ${left.kind}=>${right.kind}: size not matched`
      );
    }
  }

  // A provider that cannot store a client mtime reports none; the server mtime
  // is then the best stamp available for the copy. Keep the throw for the case
  // where there is neither, because writing a file with mtime 0 makes the next
  // local walk throw and aborts every future sync.
  const mtimeToWrite = statsLeft.mtimeCli ?? statsLeft.mtimeSvr;
  if (mtimeToWrite === undefined) {
    throw Error(`error copying ${left.kind}=>${right.kind}, no mtimeCli`);
  }

  // console.debug(`copyFile: about to start right.writeFile`);
  return {
    entity: await right.writeFile(
      key,
      content,
      mtimeToWrite,
      statsLeft.ctimeCli ?? mtimeToWrite
    ),
    content: content,
  };
}

export async function copyFileOrFolder(
  key: string,
  left: FakeFs,
  right: FakeFs
) {
  if (key.endsWith("/")) {
    return await copyFolder(key, left, right);
  } else {
    return await copyFile(key, left, right);
  }
}
