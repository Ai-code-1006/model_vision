const fs = require('node:fs');
const path = require('node:path');
const { analyzeImageFile } = require('./core/vision');

function printUsage() {
  console.error('Usage: node cli.js <image-path> [prompt]');
}

async function main() {
  const imagePath = process.argv[2];
  const prompt = process.argv[3];

  if (!imagePath) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  const resolvedPath = path.resolve(imagePath);
  if (!fs.existsSync(resolvedPath)) {
    console.error(`Image file not found: ${resolvedPath}`);
    process.exitCode = 1;
    return;
  }

  try {
    const result = await analyzeImageFile(resolvedPath, prompt);
    process.stdout.write(result);
  } catch (error) {
    console.error(error.message || String(error));
    process.exitCode = 1;
  }
}

main();
