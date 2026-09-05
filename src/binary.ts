import {inflateSync} from 'zlib';

// Двоичные секции git: `GIT binary patch`, а следом один или два блока вида
// `literal <размер>` / `delta <размер>` и строки данных. Формат разобран на
// выводе самого git, а не по документации: base85 гитовского алфавита поверх
// zlib, первый символ строки — сколько байт она несёт (A..Z = 1..26,
// a..z = 27..52). Проверено — декодированные 25 байт разжимаются в те самые
// 17 байт файла (NOT-39).
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!#$%&()*+-;<=>?@^_`{|}~';

const VALUE = new Map([...ALPHABET].map((character, at) => [character, at]));

export interface BinaryBlock {
  kind: 'literal' | 'delta';
  size: number; // размер после распаковки, как его объявил git
  lines: string[];
}

// Блоков в секции два: первый ведёт вперёд, второй — назад, для отката. Второго
// может не быть, если патч сделан без него, — тогда откат честно откажется, а
// после инверсии секции без обратного блока пустым окажется и `forward`.
export interface BinarySection {
  forward: BinaryBlock | null;
  backward: BinaryBlock | null;
}

function decodeLine(line: string): Buffer {
  const marker = line.charCodeAt(0);
  const count =
    marker >= 65 && marker <= 90 ? marker - 64 : marker >= 97 && marker <= 122 ? marker - 97 + 27 : -1;
  if (count < 0) throw new Error(`unexpected length marker ${JSON.stringify(line[0])} in a binary section`);

  const body = line.slice(1);
  const out = Buffer.alloc(Math.ceil(body.length / 5) * 4);
  let at = 0;

  for (let from = 0; from < body.length; from += 5) {
    let accumulator = 0;
    for (let k = 0; k < 5; k++) {
      const digit = VALUE.get(body[from + k]);
      if (digit === undefined) throw new Error(`unexpected character in a binary section`);
      accumulator = accumulator * 85 + digit;
    }
    // Больше 2^32 значение не бывает: пять символов base85 кодируют четыре байта.
    out.writeUInt32BE(accumulator >>> 0, at);
    at += 4;
  }

  if (count > at) throw new Error('a binary line promises more bytes than it carries');
  return out.subarray(0, count);
}

// Данные блока: строки склеиваются, потом zlib. Размер, объявленный git,
// проверяется — усечённый блок иначе лёг бы в файл молча обрезанным.
function unpack(block: BinaryBlock): Buffer {
  const packed = Buffer.concat(block.lines.map(decodeLine));
  const raw = inflateSync(packed);
  if (raw.length !== block.size) {
    throw new Error(`binary block says ${block.size} bytes but carries ${raw.length}`);
  }
  return raw;
}

// Формат дельты тот же, что у git и упакованных объектов: сначала размер
// исходного и размер результата переменной длиной, затем инструкции. Байт со
// старшим битом — «скопировать из исходного», без него — «вставить следом
// столько байт».
function readVarint(data: Buffer, at: number): [number, number] {
  let value = 0;
  let shift = 0;
  for (;;) {
    if (at >= data.length) throw new Error('binary delta ends inside a size');
    const byte = data[at++];
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return [value >>> 0, at];
    shift += 7;
  }
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let at = 0;
  let baseSize: number;
  let resultSize: number;
  [baseSize, at] = readVarint(delta, at);
  [resultSize, at] = readVarint(delta, at);

  if (baseSize !== base.length) {
    throw new Error(`binary delta expects ${baseSize} bytes to patch, found ${base.length}`);
  }

  const parts: Buffer[] = [];
  let written = 0;

  while (at < delta.length) {
    const opcode = delta[at++];

    if ((opcode & 0x80) !== 0) {
      // Смещение и длина приходят по кусочкам: бит указывает, что этот байт
      // присутствует. Отсутствующие байты — нули, а нулевая длина значит 0x10000.
      let offset = 0;
      let length = 0;
      for (let k = 0; k < 4; k++) if (opcode & (1 << k)) offset |= delta[at++] << (k * 8);
      for (let k = 0; k < 3; k++) if (opcode & (1 << (4 + k))) length |= delta[at++] << (k * 8);
      if (length === 0) length = 0x10000;

      if (offset + length > base.length) throw new Error('binary delta copies past the end of the file');
      parts.push(base.subarray(offset, offset + length));
      written += length;
      continue;
    }

    if (opcode === 0) throw new Error('binary delta has an empty instruction');
    if (at + opcode > delta.length) throw new Error('binary delta ends inside an insert');
    parts.push(delta.subarray(at, at + opcode));
    written += opcode;
    at += opcode;
  }

  if (written !== resultSize) throw new Error(`binary delta says ${resultSize} bytes but produced ${written}`);
  return Buffer.concat(parts, resultSize);
}

// Содержимое, которое секция кладёт в файл. `base` — то, что лежит там сейчас:
// для literal оно не нужно, для delta это исходник, к которому дельта считана.
export function applyBinaryBlock(block: BinaryBlock, base: Buffer): Buffer {
  const raw = unpack(block);
  return block.kind === 'literal' ? raw : applyDelta(base, raw);
}
