require('http').createServer((q, r) => { console.log('MOCK got', q.method, q.url, 'auth=' + q.headers.authorization); r.end('{}'); }).listen(9999);
