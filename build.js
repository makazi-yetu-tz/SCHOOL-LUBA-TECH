// Huunganisha server.js + public/index.html kuwa FAILI MOJA: school-luba-tech.js
const fs = require('fs');
const src = fs.readFileSync(__dirname + '/server.js', 'utf8');
const html = fs.readFileSync(__dirname + '/public/index.html', 'utf8');
const marker = '/*__INDEX_HTML__*/ null';
if (src.split(marker).length !== 2) throw new Error('alama ya INDEX_EMBED haipatikani mara moja tu');
// JSON.stringify + kuzuia </script> na U+2028/9 kuvunja msimbo
const lit = JSON.stringify(html).split(String.fromCharCode(0x2028)).join('\\u2028').split(String.fromCharCode(0x2029)).join('\\u2029');
fs.writeFileSync(__dirname + '/school-luba-tech.js', src.replace(marker, () => lit));
console.log('OK school-luba-tech.js', fs.statSync(__dirname + '/school-luba-tech.js').size, 'bytes');
