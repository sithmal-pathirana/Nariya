/**
 * Build the Chrome Web Store zip: dist/nariya-<version>.zip
 * Includes only what the extension needs at runtime (no backend, infra,
 * tests, tools or dotfiles). No dependencies: writes the zip with zlib.
 *
 *   node tools/package.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INCLUDE = ['manifest.json', 'background', 'content', 'core', 'devtools', 'icons', 'sandbox', 'ui', 'LICENSE'];
const EXCLUDE = [/(^|\/)\./, /(^|\/)node_modules\//, /^icons\/generate-icons\./];

function walk(rel) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) return [];
    if (fs.statSync(abs).isFile()) return [rel];
    return fs.readdirSync(abs).flatMap(name => walk(path.posix.join(rel, name)));
}

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
});

function crc32(buf) {
    let c = 0xffffffff;
    for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

// Fixed timestamp so the same sources always give the same zip
const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

/**
 * @param {Array<{ name: string, data: Buffer }>} files
 * @returns {Buffer}
 */
export function buildZip(files) {
    const locals = [];
    const centrals = [];
    let offset = 0;
    for (const { name, data } of files) {
        const nameBuf = Buffer.from(name);
        const deflated = zlib.deflateRawSync(data, { level: 9 });
        const useDeflate = deflated.length < data.length;
        const body = useDeflate ? deflated : data;
        const crc = crc32(data);

        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0x0800, 6); // UTF-8 names
        local.writeUInt16LE(useDeflate ? 8 : 0, 8);
        local.writeUInt16LE(DOS_TIME, 10);
        local.writeUInt16LE(DOS_DATE, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(body.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(nameBuf.length, 26);
        locals.push(local, nameBuf, body);

        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(0x0800, 8);
        central.writeUInt16LE(useDeflate ? 8 : 0, 10);
        central.writeUInt16LE(DOS_TIME, 12);
        central.writeUInt16LE(DOS_DATE, 14);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(body.length, 20);
        central.writeUInt32LE(data.length, 24);
        central.writeUInt16LE(nameBuf.length, 28);
        central.writeUInt32LE(offset, 42);
        centrals.push(central, nameBuf);

        offset += local.length + nameBuf.length + body.length;
    }
    const centralSize = centrals.reduce((n, b) => n + b.length, 0);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(files.length, 8);
    end.writeUInt16LE(files.length, 10);
    end.writeUInt32LE(centralSize, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, ...centrals, end]);
}

/**
 * Extension files that go into the store package
 * @returns {string[]} paths relative to the repo root
 */
export function collectFiles() {
    return INCLUDE.flatMap(walk)
        .filter(rel => !EXCLUDE.some(re => re.test(rel)))
        .sort();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
    const names = collectFiles();
    const zip = buildZip(names.map(name => ({ name, data: fs.readFileSync(path.join(ROOT, name)) })));
    const out = path.join(ROOT, 'dist', `nariya-${manifest.version}.zip`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, zip);
    console.log(`${path.relative(ROOT, out)}: ${names.length} files, ${(zip.length / 1024).toFixed(0)} KB`);
}
