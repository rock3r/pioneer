import crypto from "node:crypto";
import { link, open, rm } from "node:fs/promises";
import path from "node:path";

export async function writeReviewReport(target: string, report: string): Promise<void> {
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${crypto.randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let published = false;
  let failure: unknown;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(`${report}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await link(temporary, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(`Review report target already exists: ${target}`);
      }
      throw error;
    }
    published = true;
  } catch (error) {
    failure = error;
  }
  try {
    await handle?.close();
  } catch (error) {
    failure ??= error;
  }
  try {
    await rm(temporary, { force: true });
  } catch (error) {
    if (!published) failure ??= error;
  }
  if (failure !== undefined) {
    throw failure;
  }
}
