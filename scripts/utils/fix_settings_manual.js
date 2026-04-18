const fs = require('fs');
let content = fs.readFileSync('src/settings.ts', 'utf8');

// 1. Fix SVG titles for AuthModals and RevokeAuthModals in settings.ts
// Dropbox
content = content.replace(/this\.titleEl\.setText\("Connect Dropbox Account"\);/g, 'this.titleEl.innerHTML = `${SVG_DROPBOX} <span style="vertical-align: middle; margin-left: 8px;">Connect Dropbox Account</span>`;');
content = content.replace(/this\.titleEl\.setText\("Revoke Dropbox Account"\);/g, 'this.titleEl.innerHTML = `${SVG_DROPBOX} <span style="vertical-align: middle; margin-left: 8px;">Revoke Dropbox Account</span>`;');

// OneDrive
content = content.replace(/this\.titleEl\.setText\("Connect Onedrive Account"\);/g, 'this.titleEl.innerHTML = `${SVG_ONEDRIVE} <span style="vertical-align: middle; margin-left: 8px;">Connect Onedrive Account</span>`;');
content = content.replace(/this\.titleEl\.setText\("Revoke Onedrive Account"\);/g, 'this.titleEl.innerHTML = `${SVG_ONEDRIVE} <span style="vertical-align: middle; margin-left: 8px;">Revoke Onedrive Account</span>`;');

// 2. Remove the copy button logic and inject the clean button. We will manually target Dropbox and Onedrive auth modals natively.

// Dropbox AuthButton
content = content.replace(/div2\.createEl\(\s*"button",\s*\{\s*text: t\("modal_dropboxauth_copybutton"\),\s*\},\s*\(el\) => \{[\s\S]*?\}\s*\);/g, 'contentEl.createEl("button", { text: "Open Authorization in Browser" }, (el) => { el.onclick = () => window.open(authUrl); });\n');

// Dropbox anchor removal
content = content.replace(/contentEl\.createEl\("p"\)\.createEl\("a", \{\s*href: authUrl,\s*text: "[^"]*?",\s*\}\);/g, '');

// OneDrive AuthButton
content = content.replace(/div2\.createEl\(\s*"button",\s*\{\s*text: t\("modal_onedriveauth_copybutton"\),\s*\},\s*\(el\) => \{[\s\S]*?\}\s*\);/g, 'contentEl.createEl("button", { text: "Open Authorization in Browser" }, (el) => { el.onclick = () => window.open(authUrl); });\n');

// Add specific classes to Modals
content = content.replace(/this\.titleEl\.innerHTML/g, 'this.modalEl.addClass("byoc-auth-modal");\n    this.titleEl.innerHTML');

fs.writeFileSync('src/settings.ts', content, 'utf8');
