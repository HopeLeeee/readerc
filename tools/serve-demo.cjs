const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
function createServer() {
  return http.createServer((req, res) => {
    // TEST/DEMO FIXTURE ONLY. This is not an LLM and never ships in the addon.
    if (req.method === 'POST' && req.url === '/demo/model/chat/completions') {
      let body = '';
      req.on('data', chunk => { body += chunk; if (body.length > 20000) req.destroy(); });
      req.on('end', () => {
        try {
          const input = JSON.parse(body);
          const { lemma } = JSON.parse(input.messages[1].content);
          const words = { attenuate: '减弱', inflammatory: '炎症的', resilience: '恢复力', plausible: '合理的', mitigate: '减轻', cellular: '细胞的', adverse: '不利的', heterogeneous: '异质的', elucidate: '阐明', underlying: '潜在的', contradictory: '矛盾的', substantial: '重大的', conventional: '常规的', overlook: '忽略', subtle: '微妙的', molecular: '分子的', pathway: '通路', comprehensive: '全面的', temporal: '时间上的', fluctuation: '波动', spatial: '空间的', variability: '变异性', cohort: '队列', transient: '暂时的', magnitude: '幅度', specimen: '样本', rigorous: '严谨的', validation: '验证', causal: '因果的', ascertain: '确定', 'in vivo': '体内', 'in vitro': '体外', 'account for': '解释' };
          res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ gloss: words[lemma] || '释义演示' }) } }] }));
        } catch { res.writeHead(400); res.end('Invalid test payload'); }
      });
      return;
    }
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
    catch { res.writeHead(400); return res.end('Bad request'); }
    const target = path.resolve(root, '.' + (pathname === '/' ? '/demo/index.html' : pathname));
    if (!(target.startsWith(root + path.sep)) || !['/demo/', '/addon/'].some(prefix => pathname === '/' || pathname.startsWith(prefix))) {
      res.writeHead(403); return res.end('Forbidden');
    }
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8' };
    fs.stat(target, (err, stat) => {
      if (err || !stat.isFile()) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': types[path.extname(target)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      fs.createReadStream(target).pipe(res);
    });
  });
}
if (require.main === module) {
  const port = Number(process.env.PORT || 4173);
  createServer().listen(port, '127.0.0.1', () => console.log(`ReaderC demo: http://127.0.0.1:${port}`));
}
module.exports = { createServer };
