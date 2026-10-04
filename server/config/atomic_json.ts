import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
/** Never expose a partially written configuration file. */
export function writeJsonAtomic(destination: string, value: unknown): void {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const temporary = destination + '.' + crypto.randomUUID() + '.tmp';
    let descriptor: number | undefined;
    try {
        descriptor = fs.openSync(temporary, 'wx', 0o600);
        fs.writeFileSync(descriptor, JSON.stringify(value, null, 2) + '\n', 'utf8');
        fs.fsyncSync(descriptor);
        fs.closeSync(descriptor);
        descriptor = undefined;
        fs.renameSync(temporary, destination);
    }
    finally {
        if (descriptor !== undefined)
            fs.closeSync(descriptor);
        try {
            fs.unlinkSync(temporary);
        }
        catch (error: any) {
            if (error.code !== 'ENOENT')
                throw error;
        }
    }
}
