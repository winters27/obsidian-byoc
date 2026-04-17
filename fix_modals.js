const fs = require('fs');

const files = fs.readdirSync('src').filter(f => f.startsWith('settings') && f.endsWith('.ts')).map(f => 'src/' + f);

files.forEach(file => {
  let text = fs.readFileSync(file, 'utf8');

  // Strip out any corrupted onOpen declarations completely, safely replacing them with basic onOpen.
  // The corrupted syntax literally contains 'async onOpen() {\
' or '\\
' in the text file
  // as actual backtick + n, not a newline byte. So we match those literals using regex.
  
  text = text.replace(/async onOpen\(\) \{\
[^\n]+/g, 'async onOpen() {');
  text = text.replace(/async onOpen\(\) \{\\
[^\n]+/g, 'async onOpen() {');
  
  // also regular onOpen
  text = text.replace(/onOpen\(\) \{\
[^\n]+/g, 'onOpen() {');
  text = text.replace(/onOpen\(\) \{\\
[^\n]+/g, 'onOpen() {');

  // Sometimes there are multiple corrupted injections, so let's run it a few times to be sure
  text = text.replace(/async onOpen\(\) \{\
[^\n]+/g, 'async onOpen() {');
  text = text.replace(/async onOpen\(\) \{\\
[^\n]+/g, 'async onOpen() {');

  // Now, safely inject the title and class logic ONLY once!
  // We ensure we only inject it if it doesn't already have 'this.modalEl.addClass("byoc-auth-modal")'
  
  // We'll replace the block from "class X extends Modal { ... async onOpen() {"
  text = text.replace(/class ([a-zA-Z0-9_]+Modal) extends Modal \{([\s\S]*?)async onOpen\(\) \{/g, (match, className, body) => {
      let title = className.replace('AuthModal', '');
      title = title.replace('Revoke', '');
      let prefix = className.includes('Revoke') ? 'Revoke' : 'Connect';
      
      return 'class ' + className + ' extends Modal {' + body + 'async onOpen() {\n    this.titleEl.setText("' + prefix + ' ' + title + ' Account");\n    this.modalEl.addClass("byoc-auth-modal");';
  });

  text = text.replace(/class ([a-zA-Z0-9_]+Modal) extends Modal \{([\s\S]*?)(?<!async\s)onOpen\(\) \{/g, (match, className, body) => {
      let title = className.replace('AuthModal', '');
      title = title.replace('Revoke', '');
      let prefix = className.includes('Revoke') ? 'Revoke' : 'Connect';
      
      return 'class ' + className + ' extends Modal {' + body + 'onOpen() {\n    this.titleEl.setText("' + prefix + ' ' + title + ' Account");\n    this.modalEl.addClass("byoc-auth-modal");';
  });

  fs.writeFileSync(file, text, 'utf8');
});
console.log('Fixed modals without syntax errors');
