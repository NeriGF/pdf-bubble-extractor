import { NextResponse } from 'next/server';
export const dynamic = 'force-dynamic';
import OpenAI from 'openai';
const pdf = require('pdf-parse');

function render_page(pageData: any) {
  return pageData.getTextContent().then(function(textContent: any) {
    let text = '';
    for (let item of textContent.items) {
      text += item.str + " ";
    }
    return `\n--- PAGE ${pageData.pageNumber} ---\n` + text;
  });
}

export async function POST(req: Request) {
  try {
    const openai = new OpenAI(); // Uses OPENAI_API_KEY from environment
    const formData = await req.formData();
    const file = formData.get('file') as File;
    const isFull = formData.get('full') === 'true';

    if (!file) {
      return NextResponse.json({ error: 'No file uploaded' }, { status: 400 });
    }

    const bytes = await file.arrayBuffer();
    const buffer = Buffer.from(bytes);

    // Extract text from PDF
    let text = '';
    try {
      const options = { pagerender: render_page };
      const pdfData = await pdf(buffer, options);
      text = pdfData.text;
    } catch (parseError: any) {
      console.warn(`Primary PDF parsing failed for ${file.name}, attempting fallback:`, parseError.message);
      try {
        const { getDocumentProxy } = await import('unpdf');
        const pdfProxy = await getDocumentProxy(new Uint8Array(buffer));
        
        for (let i = 1; i <= pdfProxy.numPages; i++) {
          const page = await pdfProxy.getPage(i);
          const content = await page.getTextContent();
          const pageText = content.items.map((item: any) => item.str).join(' ');
          text += `\n--- PAGE ${i} ---\n${pageText}\n`;
        }
      } catch (fallbackError: any) {
        console.error(`Fallback PDF parsing failed for ${file.name}:`, fallbackError.message);
        return NextResponse.json({ 
          error: 'Could not read this PDF. Try exporting/printing it to a new PDF and upload again.' 
        }, { status: 500 });
      }
    }

    if (!text || text.trim().length === 0) {
      return NextResponse.json({ error: 'No text could be extracted from this PDF' }, { status: 400 });
    }

    const MAX_CHARS = isFull ? 50000 : 12000;
    const isPreview = !isFull && text.length > MAX_CHARS;
    const truncatedText = text.length > MAX_CHARS ? text.substring(0, MAX_CHARS) : text;

    // Send to OpenAI
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `You are an AI assistant that extracts key points from a document.
Extract the following elements: dates, money amounts, risks or warnings, and required actions.
You MUST extract 4 to 10 distinct insights per page if the text permits.
For each element, assign an importance ("high", "medium", or "low").

IMPORTANT INSTRUCTIONS:
- Group related insights: If multiple items belong to the same step (e.g. setup, testing), combine them into a single, meaningful callout rather than multiple overly granular or redundant ones.
- Create action-oriented titles (e.g., "Final test timing risk" instead of "Test timing", "Prepare promo codes" instead of "Promo codes usage").
- The text contains page markers like "--- PAGE X ---". Use these to accurately determine the sourcePage.
- Quote a short, exact snippet from the text as the sourceText.
- Assign a confidenceScore between 0.0 and 1.0 based on how clear the text is.

Return the result as a structured JSON object exactly matching this schema:
{
  "bubbles": [
    {
      "title": "Action-oriented title (3-5 words)",
      "type": "date" | "money" | "risk" | "action",
      "importance": "high" | "medium" | "low",
      "summary": "1-2 sentence summary of the point",
      "consequence": "What happens if this is ignored or what is the context?",
      "action": "What needs to be done about this (if anything)?",
      "sourcePage": number,
      "sourceText": "Exact quoted snippet from the text",
      "confidenceScore": number
    }
  ]
}
Ensure all keys are populated and the response is ONLY valid JSON.
`
        },
        {
          role: 'user',
          content: `Here is the extracted document text:\n\n${truncatedText}` // Limit text to avoid token limits just in case
        }
      ],
      response_format: { type: 'json_object' },
    });

    const resultText = completion.choices[0].message.content || '{"bubbles": []}';
    const result = JSON.parse(resultText);

    return NextResponse.json({
      bubbles: result.bubbles,
      documentText: truncatedText,
      isPreview: isPreview
    });
  } catch (error: any) {
    console.error('Error processing PDF:', error);
    return NextResponse.json({ error: error.message || 'Failed to process PDF' }, { status: 500 });
  }
}
