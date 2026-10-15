/** Explicitly injected persistent volume; constructing this adapter opens nothing. */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SharedJournalStorage } from './sharedJournal';

export function createFilesystemJournalStorage(root: string): SharedJournalStorage {
 if (!path.isAbsolute(root) || root === path.parse(root).root) throw Error('JOURNAL_VOLUME_REQUIRED');
 const resolve = (key: string) => {
  if (!/^publishing\/[A-Za-z0-9_-]+\/[a-f0-9]{64}$/.test(key)) throw Error('INVALID_JOURNAL_KEY');
  return path.join(root, key);
 };
 async function sync(directory: string) { const handle = await fs.open(directory, 'r'); try { await handle.sync(); } finally { await handle.close(); } }
 return {
  async putIfAbsent(key, value) {
   if (Buffer.byteLength(value) > 4096) throw Error('JOURNAL_EVENT_TOO_LARGE');
   const destination = resolve(key), directory = path.dirname(destination);
   await fs.mkdir(directory, {recursive:true, mode:0o700});
   const temporary = path.join(directory, `.pending-${randomUUID()}`);
   const handle = await fs.open(temporary, 'wx', 0o600);
   try { await handle.writeFile(value); await handle.sync(); } finally { await handle.close(); }
   try {
    // link is atomic create-if-absent: concurrent writers never overwrite evidence.
    try { await fs.link(temporary, destination); } catch (error) {
     if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
     if (await fs.readFile(destination, 'utf8') !== value) throw Error('JOURNAL_STORAGE_CONFLICT');
    }
    await sync(directory); await sync(path.dirname(directory)); await sync(root);
    return {durablyCommitted:true as const};
   } finally { await fs.unlink(temporary).catch(()=>{}); }
  },
  async read(key) { return fs.readFile(resolve(key), 'utf8'); },
  async list(prefix) {
   if (!/^publishing\/[A-Za-z0-9_-]+\/$/.test(prefix)) throw Error('INVALID_JOURNAL_PREFIX');
   const directory = path.join(root, prefix);
   try { return (await fs.readdir(directory)).filter(name=>/^[a-f0-9]{64}$/.test(name)).sort().map(name=>prefix+name); }
   catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  }
 };
}
