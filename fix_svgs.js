const fs = require('fs');

const svgMap = {
  'Dropbox': 'SVG_DROPBOX',
  'Onedrive': 'SVG_ONEDRIVE',
  'Onedrivefull': 'SVG_ONEDRIVE',
  'GoogleDrive': 'SVG_GDRIVE',
  'Box': 'SVG_BOX',
  'PCloud': 'SVG_PCLOUD',
  'Koofr': 'SVG_KOOFR',
  'YandexDisk': 'SVG_YANDEX'
};

const files = fs.readdirSync('src').filter(f => f.startsWith('settings') && f.endsWith('.ts')).map(f => 'src/' + f);

files.forEach(file => {
  let content = fs.readFileSync(file, 'utf8');

  // Fix the broken SVG injection
  content = content.replace(/this\.titleEl\.innerHTML = \\ <span>(Connect|Revoke) ([A-Za-z0-9_]+) Account<\/span>;/g, (match, action, provider) => {
      const svgVar = svgMap[provider] || 'SVG_PCLOUD';
      return 'this.titleEl.innerHTML = `' + '${' + svgVar + '}' + ' <span style="vertical-align: middle; margin-left: 8px;">' + action + ' ' + provider + ' Account</span>`;';
  });
  
  // Wait, no backslash was literally rendered in TS because TS sees `\ ` as just a space in a syntax error?
  // Let's just catch anything between innerHTML = and <span>

  content = content.replace(/this\.titleEl\.innerHTML = [\s\S]*?<span>(Connect|Revoke) ([A-Za-z0-9_]+) Account<\/span>[^;]*;/g, (match, action, provider) => {
      const svgVar = svgMap[provider] || 'SVG_PCLOUD';
      return 'this.titleEl.innerHTML = `' + '${' + svgVar + '}' + ' <span style="vertical-align: middle; margin-left: 8px;">' + action + ' ' + provider + ' Account</span>`;';
  });

  fs.writeFileSync(file, content, 'utf8');
});
