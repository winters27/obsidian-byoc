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

  // 1. Upgrade titles to include SVG
  content = content.replace(/this\.titleEl\.setText\(\"(Connect|Revoke) ([A-Za-z0-9_]+) Account\"\);/g, (match, action, provider) => {
      const svgVar = svgMap[provider] || 'SVG_PCLOUD';
      return 'this.titleEl.innerHTML = \\ <span>' + action + ' ' + provider + ' Account</span>\;';
  });

  // 2. Eradicate Copy Button & A Tag, replace with unified Browser Button
  // We use a robust regex that matches div2.createEl("button", { text: t("..._copybutton") }, ... );
  
  // NOTE: In settingsBox, settingsKoofr, etc., the text is 	ext: t("modal_boxauth_copybutton")
  content = content.replace(/div2\.createEl\(\s*\"button\"[\s\S]*?_copybutton\"[\s\S]*?^\s*\}\);\s*/gm, 'contentEl.createEl(\"button\", { text: \"Open Authorization in Browser\" }, (el) => { el.onclick = () => window.open(authUrl); });\n\n');
  
  // Actually, some might not match uniquely. Let's just match any div2.createEl("button" that writes to clipboard!
  content = content.replace(/div2\.createEl\(\s*\"button\"[\s\S]*?navigator\.clipboard\.writeText[\s\S]*?^\s*\}\);\s*/gm, 'contentEl.createEl(\"button\", { text: \"Open Authorization in Browser\" }, (el) => { el.onclick = () => window.open(authUrl); });\n\n');

  // Handle a tags: contentEl.createEl("p").createEl("a", ...);
  content = content.replace(/contentEl\.createEl\(\"p\"\)\.createEl\(\"a\"[\s\S]*?^\s*\}\);\s*/gm, '');

  fs.writeFileSync(file, content, 'utf8');
});

console.log('Successfully upgraded all modals');
