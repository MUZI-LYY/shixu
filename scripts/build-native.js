const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
if (process.platform !== 'darwin') process.exit(0);
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'native', 'workspace-native');
const sources = ['WorkspaceNative.m', 'Info.plist'].map(name => path.join(root, 'native', name));
if (fs.existsSync(output) && sources.every(file => fs.statSync(file).mtimeMs < fs.statSync(output).mtimeMs)) process.exit(0);
execFileSync('clang', ['-O2', '-fobjc-arc', '-mmacosx-version-min=13.0', sources[0], '-framework', 'Foundation', '-framework', 'Vision', '-framework', 'ImageIO', '-framework', 'EventKit', '-framework', 'AppKit', '-framework', 'ApplicationServices',
  '-Wl,-sectcreate,__TEXT,__info_plist,' + sources[1], '-o', output], { stdio: 'inherit' });
execFileSync('codesign', ['--force', '--sign', '-', '--identifier', 'com.personal.voiceworkspace.native', output], { stdio: 'inherit' });
