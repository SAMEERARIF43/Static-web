const fs = require('fs');
const path = require('path');

function getWebPDimensions(filePath) {
  const buf = fs.readFileSync(filePath);
  
  // WebP format: RIFF header (12 bytes), then VP8/VP8L/VP8X chunk
  const riff = buf.toString('ascii', 0, 4);
  const webp = buf.toString('ascii', 8, 12);
  
  if (riff !== 'RIFF' || webp !== 'WEBP') {
    console.log('Not a valid WebP file');
    return;
  }
  
  const chunkType = buf.toString('ascii', 12, 16);
  console.log('Chunk type:', chunkType);
  
  if (chunkType === 'VP8 ') {
    // Lossy VP8
    // Frame tag at offset 20+3=23, then key frame header
    const width = buf.readUInt16LE(26) & 0x3FFF;
    const height = buf.readUInt16LE(28) & 0x3FFF;
    console.log(`Dimensions: ${width} x ${height}`);
  } else if (chunkType === 'VP8L') {
    // Lossless VP8L
    // Signature byte at offset 21, then 4 bytes of width/height
    const bits = buf.readUInt32LE(21);
    const width = (bits & 0x3FFF) + 1;
    const height = ((bits >> 14) & 0x3FFF) + 1;
    console.log(`Dimensions: ${width} x ${height}`);
  } else if (chunkType === 'VP8X') {
    // Extended VP8X
    const width = (buf.readUIntLE(24, 3)) + 1;
    const height = (buf.readUIntLE(27, 3)) + 1;
    console.log(`Dimensions: ${width} x ${height}`);
  } else {
    console.log('Unknown WebP chunk type:', chunkType);
  }
  
  console.log('File size:', buf.length, 'bytes', '(' + (buf.length / 1024).toFixed(1) + ' KB)');
}

const imgPath = path.join(__dirname, 'public', 'websites picture.webp');
getWebPDimensions(imgPath);
