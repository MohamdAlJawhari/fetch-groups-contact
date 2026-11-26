import { PassThrough, type Writable } from 'node:stream';
import archiver from 'archiver';
import type { CategorizedContacts } from '../platforms/platform.types.js';
import { ExcelWriter } from './excel.writer.js';

export interface ExportFile { name: string; contacts: CategorizedContacts }

/**
 * Streams a .zip with one workbook per file into `stream` (docs/specs/05-export.md 4.6).
 * Each workbook is built in memory first (never on disk) and stored uncompressed: an .xlsx is already a zip.
 */
export class ZipWriter {
  constructor(private readonly excel: ExcelWriter = new ExcelWriter()) {}

  async write(files: readonly ExportFile[], stream: Writable): Promise<void> {
    if (stream.destroyed || stream.writableEnded) throw new Error('Output stream is not writable');
    const archive = archiver('zip', { store: true });

    let detach = () => {};
    const failed = new Promise<never>((_resolve, reject) => {
      let finished = false;
      const onFinish = () => { finished = true; };
      const onError = (error: Error) => reject(error);
      const onClose = () => { if (!finished) reject(new Error('Output stream closed before the archive was written')); };
      stream.on('finish', onFinish).on('error', onError).on('close', onClose);
      archive.on('error', onError).on('warning', onError);
      detach = () => {
        stream.off('finish', onFinish).off('error', onError).off('close', onClose);
        archive.off('error', onError).off('warning', onError);
      };
    });
    failed.catch(() => {});
    const finished = new Promise<void>(resolve => stream.once('finish', () => resolve()));

    const build = async () => {
      archive.pipe(stream);
      for (const file of files) archive.append(await this.workbook(file.contacts), { name: file.name });
      await archive.finalize();
      await finished;
    };

    try {
      await Promise.race([build(), failed]);
    } catch (error) {
      archive.abort();
      throw error;
    } finally {
      detach();
    }
  }

  private async workbook(contacts: CategorizedContacts): Promise<Buffer> {
    const sink = new PassThrough();
    const chunks: Buffer[] = [];
    const ended = new Promise<void>((resolve, reject) => sink.on('end', resolve).on('error', reject));
    sink.on('data', (chunk: Buffer) => chunks.push(chunk));
    await this.excel.write(contacts, sink);
    if (!sink.writableEnded) sink.end();
    await ended;
    return Buffer.concat(chunks);
  }
}
