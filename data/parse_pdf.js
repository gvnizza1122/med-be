const fs = require('fs');
const { PDFParse } = require('pdf-parse');

const pdfPath = 'd:\\Downloads\\eclaim\\contoh-data-calim\\sosialisasi-ba-kesepakatan-bpjs-no-1247-thn-2024_compress.pdf';

async function parse() {
    try {
        const dataBuffer = fs.readFileSync(pdfPath);
        // Convert Buffer to Uint8Array as required by this library version
        const uint8Array = new Uint8Array(dataBuffer);
        const parser = new PDFParse(uint8Array);
        const textResult = await parser.getText();
        
        fs.writeFileSync('d:\\Downloads\\eclaim\\backend\\data\\pdf_text.txt', textResult.text, 'utf-8');
        console.log('PDF text successfully extracted! Length:', textResult.text.length);
        
        // Find some keywords
        const keywords = ['kelas', 'tarif', 'diagnosa', 'sep', 'discharge', 'prosedur'];
        keywords.forEach(kw => {
            const count = (textResult.text.match(new RegExp(kw, 'gi')) || []).length;
            console.log(`Keyword "${kw}": ${count} matches`);
        });
    } catch (err) {
        console.error('Error parsing PDF:', err);
    }
}

parse();
