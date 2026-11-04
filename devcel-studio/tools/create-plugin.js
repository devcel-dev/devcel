#!/usr/bin/env node

/**
 * Devcel Plugin Creator CLI Tool
 * 
 * Usage: node create-plugin.js <plugin-name>
 * 
 * This tool creates a new Devcel plugin from the template
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

// Template variables that will be replaced
const TEMPLATE_VARS = {
  'your-plugin-name': '',
  'Your Plugin Name': '',
  'YourPluginName': '',
  'your-username': '',
  'Your Name': '',
  'your.email@example.com': '',
  'Description of your Devcel plugin': '',
  'Description of what your plugin does': ''
};

// CLI interface
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function ask(question) {
  return new Promise((resolve) => {
    rl.question(question, resolve);
  });
}

function toPascalCase(str) {
  return str
    .split(/[-_\s]/)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join('');
}

function toKebabCase(str) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

async function collectInformation() {
  console.log('🚀 Devcel Plugin Creator');
  console.log('========================');
  console.log('');

  const pluginName = await ask('Plugin name (e.g., my-awesome-plugin): ');
  const displayName = await ask('Display name (e.g., My Awesome Plugin): ');
  const author = await ask('Author name: ');
  const email = await ask('Author email: ');
  const username = await ask('GitHub username: ');
  const description = await ask('Short description: ');
  const detailedDescription = await ask('Detailed description: ');

  return {
    'your-plugin-name': toKebabCase(pluginName),
    'Your Plugin Name': displayName || pluginName,
    'YourPluginName': toPascalCase(pluginName),
    'your-username': username,
    'Your Name': author,
    'your.email@example.com': email,
    'Description of your Devcel plugin': description,
    'Description of what your plugin does': detailedDescription || description
  };
}

function copyDirectory(src, dest, replacements) {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }

  const items = fs.readdirSync(src);

  for (const item of items) {
    const srcPath = path.join(src, item);
    const destPath = path.join(dest, item);
    const stat = fs.statSync(srcPath);

    if (stat.isDirectory()) {
      copyDirectory(srcPath, destPath, replacements);
    } else {
      copyFile(srcPath, destPath, replacements);
    }
  }
}

function copyFile(src, dest, replacements) {
  let content = fs.readFileSync(src, 'utf8');

  // Replace template variables
  for (const [search, replace] of Object.entries(replacements)) {
    const regex = new RegExp(escapeRegExp(search), 'g');
    content = content.replace(regex, replace);
  }

  fs.writeFileSync(dest, content);
}

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function createPlugin() {
  try {
    // Collect user information
    const replacements = await collectInformation();
    
    // Validate plugin name
    const pluginName = replacements['your-plugin-name'];
    if (!pluginName || !/^[a-z0-9-]+$/.test(pluginName)) {
      console.error('❌ Invalid plugin name. Use lowercase letters, numbers, and hyphens only.');
      process.exit(1);
    }

    // Check if directory already exists
    const targetDir = path.resolve(pluginName);
    if (fs.existsSync(targetDir)) {
      console.error(`❌ Directory '${pluginName}' already exists.`);
      process.exit(1);
    }

    // Get template directory
    const templateDir = path.join(__dirname, '..', 'templates', 'plugin-template');
    if (!fs.existsSync(templateDir)) {
      console.error('❌ Plugin template not found.');
      process.exit(1);
    }

    console.log('');
    console.log('📁 Creating plugin directory...');
    
    // Copy template files
    copyDirectory(templateDir, targetDir, replacements);

    // Create additional files
    createGitignore(targetDir);
    createLicense(targetDir, replacements);

    console.log('✅ Plugin created successfully!');
    console.log('');
    console.log('Next steps:');
    console.log(`1. cd ${pluginName}`);
    console.log('2. npm install');
    console.log('3. npm run build');
    console.log('4. Start developing your plugin!');
    console.log('');
    console.log('Documentation:');
    console.log('- Plugin Development Guide: docs/plugin-development-guide.md');
    console.log('- API Reference: docs/plugin-api-reference.md');
    console.log('');

  } catch (error) {
    console.error('❌ Error creating plugin:', error.message);
    process.exit(1);
  } finally {
    rl.close();
  }
}

function createGitignore(targetDir) {
  const gitignoreContent = `# Dependencies
node_modules/
npm-debug.log*
yarn-debug.log*
yarn-error.log*

# Production builds
dist/
build/

# Environment variables
.env
.env.local
.env.development.local
.env.test.local
.env.production.local

# IDE
.vscode/
.idea/
*.swp
*.swo

# OS
.DS_Store
Thumbs.db

# Logs
logs/
*.log

# Testing
coverage/
.nyc_output/

# Temporary files
tmp/
temp/
`;

  fs.writeFileSync(path.join(targetDir, '.gitignore'), gitignoreContent);
}

function createLicense(targetDir, replacements) {
  const licenseContent = `MIT License

Copyright (c) ${new Date().getFullYear()} ${replacements['Your Name']}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

  fs.writeFileSync(path.join(targetDir, 'LICENSE'), licenseContent);
}

// Main execution
if (require.main === module) {
  createPlugin().catch(console.error);
}

module.exports = { createPlugin };