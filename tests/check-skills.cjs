// 检查 SKILL.md 是否符合 docs/skill-writing-spec.md 的机器可判定部分。只读,不改任何文件。
// 用法:
//   node tests/check-skills.cjs                      检查全部 skill
//   node tests/check-skills.cjs influx-ai/tools/x    只检查指定 skill(目录或 SKILL.md 路径,可多个)
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

const root = path.resolve(__dirname, '../influx-ai');
const failures = [];
const fail = (where, msg) => failures.push(`${where}: ${msg}`);
const rel = (p) => path.relative(root, p).split(path.sep).join('/') || '.';
const read = (p) => fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === '.git' || e.name === 'node_modules') return [];
    const full = path.join(dir, e.name);
    return e.isDirectory() ? walk(full) : [full];
  });
}

// 解析 frontmatter 顶层键。支持单行、引号、| 和 > 块标量、缩进续行。
function parseFrontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---(\n|$)/);
  if (!m) return null;
  const lines = m[1].split('\n');
  const out = {};
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!kv) continue;
    const [, key, raw] = kv;
    const block = [];
    while (i + 1 < lines.length && (/^\s/.test(lines[i + 1]) || lines[i + 1] === '')) block.push(lines[++i]);
    const dedent = block.map((l) => l.replace(/^\s+/, ''));
    if (/^[|>][+-]?$/.test(raw)) {
      out[key] = (raw[0] === '|' ? dedent.join('\n') : dedent.join(' ')).trim();
    } else {
      let v = [raw, ...dedent].join(' ').trim();
      if (/^(".*"|'.*')$/.test(v)) v = v.slice(1, -1);
      out[key] = v;
    }
  }
  return out;
}

function resolveSkills(args) {
  if (!args.length) return walk(root).filter((f) => path.basename(f) === 'SKILL.md');
  return args.map((a) => {
    let p = path.resolve(process.cwd(), a);
    if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, 'SKILL.md');
    if (!fs.existsSync(p)) { fail(a, '找不到 SKILL.md'); return null; }
    return p;
  }).filter(Boolean);
}

const stripFences = (t) => t.replace(/```[\s\S]*?```/g, '');
const skills = resolveSkills(process.argv.slice(2));
const checkedRefs = new Set();

for (const file of skills) {
  const where = rel(file);
  const dir = path.dirname(file);
  const text = read(file);

  // 规范 §3 frontmatter
  const fm = parseFrontmatter(text);
  if (!fm) { fail(where, '缺少 frontmatter'); continue; }
  const { name, description } = fm;
  if (!name) fail(where, 'name 缺失');
  else {
    if ([...name].length > 64) fail(where, `name 超过 64 字符(${[...name].length})`);
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) fail(where, `name 格式不合规(仅小写字母/数字/单个连字符,不以连字符开头或结尾): ${name}`);
    if (name !== path.basename(dir)) fail(where, `name "${name}" 与目录名 "${path.basename(dir)}" 不一致`);
    if (/anthropic|claude/.test(name)) fail(where, `name 含保留词: ${name}`);
    if (/<\/?[a-zA-Z][^>]*>/.test(name)) fail(where, 'name 含 XML 标签');
  }
  if (!description) fail(where, 'description 缺失或为空');
  else {
    const len = [...description].length;
    if (len > 1024) fail(where, `description 超过 1024 字符(${len})`);
    if (/<\/?[a-zA-Z][^>]*>/.test(description)) fail(where, 'description 含 XML 标签');
  }

  // 规范 §4 行数
  const lineCount = text.replace(/\n$/, '').split('\n').length;
  if (lineCount > 500) fail(where, `超过 500 行(${lineCount})`);

  // 规范 §2 链接:存在、无反斜杠。代码块内的内容不算链接。
  for (const m of stripFences(text).matchAll(/\]\(([^)\s]+)[^)]*\)/g)) {
    const raw = m[1];
    if (/^(https?:|mailto:|#)/.test(raw) || raw.includes('<')) continue;
    if (raw.includes('\\')) fail(where, `链接路径含反斜杠: ${raw}`);
    const target = raw.split('#')[0].replace(/\\/g, '/');
    if (!target) continue;
    const abs = path.resolve(dir, target);
    if (!fs.existsSync(abs)) { fail(where, `链接目标不存在: ${raw}`); continue; }
    if (abs.endsWith('.md') && abs !== file && /(^|[\\/])references[\\/]/.test(abs)) checkedRefs.add(abs);
  }

  // 规范 §5 命令中的脚本路径。同时兼容 node scripts/x.mjs(相对包根)和 node ../../scripts/x.mjs(相对 SKILL.md 所在目录)。
  for (const m of text.matchAll(/\bnode\s+((?:\.\.\/)*scripts\/[\w./-]+\.mjs)/g)) {
    const base = m[1].startsWith('../') ? dir : root;
    if (!fs.existsSync(path.resolve(base, m[1]))) fail(where, `命令中的脚本不存在: ${m[1]}`);
  }
  if (/\bnode\s+[^\n]*scripts\\/.test(text)) fail(where, '命令路径含反斜杠');
}

// 规范 §2:超过 100 行的 reference 前 20 行内要有含"目录"或"Contents"的标题
for (const ref of checkedRefs) {
  const lines = read(ref).replace(/\n$/, '').split('\n');
  if (lines.length > 100 && !lines.slice(0, 20).some((l) => /^#{1,6}\s.*(目录|Contents)/i.test(l))) {
    fail(rel(ref), `${lines.length} 行但前 20 行内没有"目录"/"Contents"标题`);
  }
}

// 脚本语法
const scriptDir = path.join(root, 'scripts');
if (fs.existsSync(scriptDir)) {
  for (const f of walk(scriptDir).filter((f) => f.endsWith('.mjs'))) {
    const r = cp.spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
    if (r.status !== 0) fail(rel(f), `语法错误 ${r.stderr.trim().split('\n')[0]}`);
  }
}

// 版本一致(仅全量检查)
if (process.argv.length <= 2) {
  try {
    const version = JSON.parse(read(path.join(root, 'skill.json'))).version;
    const manifestPath = path.join(root, 'skill-manifest.json');
    if (fs.existsSync(manifestPath) && JSON.parse(read(manifestPath)).latest_version !== version) fail('skill-manifest.json', `latest_version 与 skill.json(${version}) 不一致`);
    if (!read(path.join(root, 'SKILL.md')).includes(`version: "${version}"`)) fail('SKILL.md', `未包含 version: "${version}"`);
  } catch (e) {
    fail('skill.json', `读取版本失败: ${e.message}`);
  }
}

console.log(JSON.stringify({ skills: skills.map(rel), references: [...checkedRefs].map(rel), failures }, null, 2));
process.exitCode = failures.length ? 1 : 0;
