// Demo client to send "follow along" events into the extension's local server.
//
// Usage:
//   node demo/send-event.js --file "C:\path\to\file.ts" --start 10 --end 20 --port 53931
//
// You can also try PowerShell:
//   curl http://127.0.0.1:53931/event -Method POST -ContentType "application/json" -Body '{"type":"show","filePath":"C:\\path\\file.ts","startLine":10,"endLine":20}'

const http = require('http');

function parseArgs(argv) {
  /** @type {Record<string, string>} */
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        out[key] = 'true';
      } else {
        out[key] = next;
        i++;
      }
    }
  }
  return out;
}

function usageAndExit() {
  // eslint-disable-next-line no-console
  console.log(
    [
      'Usage:',
      '  node demo/send-event.js --file "C:\\path\\to\\file.ts" --start 10 --end 20 [--port 53931]',
      '',
      'Examples:',
      '  node demo/send-event.js --file "C:\\\\Users\\\\user\\\\Projects\\\\_Active_\\\\debrief\\\\src\\\\tool.ts" --start 1 --end 30',
    ].join('\n')
  );
  process.exit(1);
}

async function main() {
  const args = parseArgs(process.argv);

  const filePath = args.file || args.filePath;
  const startLine = Number(args.start ?? '1');
  const endLine = Number(args.end ?? String(startLine));
  const port = Number(args.port ?? '53931');

  if (!filePath) usageAndExit();
  if (!Number.isFinite(startLine) || startLine < 1) usageAndExit();
  if (!Number.isFinite(endLine) || endLine < startLine) usageAndExit();
  if (!Number.isFinite(port) || port < 1) usageAndExit();

  const payload = JSON.stringify({
    type: 'show',
    filePath,
    startLine,
    endLine,
    message: `demo: ${filePath} (${startLine}-${endLine})`,
  });

  const req = http.request(
    {
      hostname: '127.0.0.1',
      port,
      path: '/event',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      },
    },
    (res) => {
      let data = '';
      res.on('data', (c) => (data += String(c)));
      res.on('end', () => {
        // eslint-disable-next-line no-console
        console.log(`HTTP ${res.statusCode}: ${data}`);
      });
    }
  );

  req.on('error', (err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });

  req.write(payload);
  req.end();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});

