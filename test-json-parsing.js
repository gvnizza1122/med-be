#!/usr/bin/env node
/**
 * Test: JSON Response Parsing & Fallback Logic
 *
 * Validates:
 * 1. Valid JSON parsing from plain response
 * 2. JSON extraction from markdown code blocks
 * 3. Fallback on parse failures
 * 4. Response normalization
 */

// Setup env
process.env.OPENROUTER_API_KEY = 'sk-or-test';
process.env.OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
process.env.OPENROUTER_MODEL = 'openai/gpt-oss-20b:free';

const testCases = [
  {
    name: 'Valid JSON - plain response',
    input: '{"field_name":"sep","status":"failed","error_description":"Uppercase required","suggestion":"Change to uppercase","confidence_score":0.85}',
    shouldPass: true,
  },
  {
    name: 'Valid JSON - markdown code block',
    input: '```json\n{"field_name":"nokartu","status":"failed","error_description":"13 digits required","suggestion":"Check format","confidence_score":0.9}\n```',
    shouldPass: true,
  },
  {
    name: 'Valid JSON - markdown without json tag',
    input: '```\n{"field_name":"tarif","status":"passed","error_description":"","suggestion":"","confidence_score":0.95}\n```',
    shouldPass: true,
  },
  {
    name: 'Valid JSON - multiple code blocks (uses first)',
    input: '```json\n{"field_name":"sep","status":"failed","error_description":"Bad","suggestion":"Fix","confidence_score":0.7}\n```\nSome extra text\n```json\n{"ignore":true}\n```',
    shouldPass: true,
  },
  {
    name: 'Invalid JSON - malformed',
    input: '{invalid json here}',
    shouldPass: false, // Should fallback
  },
  {
    name: 'Empty response',
    input: '',
    shouldPass: false, // Should fallback
  },
];

console.log('\n╔════════════════════════════════════════════════════╗');
console.log('║        JSON Parsing & Fallback Tests             ║');
console.log('╚════════════════════════════════════════════════════╝\n');

let passed = 0;
let failed = 0;

testCases.forEach((testCase, idx) => {
  console.log(`Test ${idx + 1}: ${testCase.name}`);

  try {
    // Simulate parsing logic from aiValidationService.js
    let auditResult;
    let parseErr = null;

    try {
      // Try extract from markdown
      let jsonStr = testCase.input;
      const codeBlockMatch = testCase.input.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (codeBlockMatch) {
        jsonStr = codeBlockMatch[1].trim();
      }
      auditResult = JSON.parse(jsonStr);
    } catch (e) {
      parseErr = e.message;
      // Fallback
      auditResult = {
        field_name: 'unknown',
        status: 'failed',
        error_description: `Parse error: ${e.message}`,
        suggestion: 'Consult with verifier',
        confidence_score: 0.3,
      };
    }

    // Verify required fields
    if (!auditResult.field_name || !auditResult.status) {
      throw new Error('Missing required fields in response');
    }

    // Validate structure
    const normalized = {
      field_name: auditResult.field_name,
      status: auditResult.status,
      error_description: auditResult.error_description || '',
      suggestion: auditResult.suggestion || '',
      confidence_score: Math.max(0, Math.min(1, Number(auditResult.confidence_score) || 0.5)),
    };

    // Check expectations
    if (testCase.shouldPass && parseErr) {
      throw new Error(`Expected parse to succeed but got: ${parseErr}`);
    }

    if (!testCase.shouldPass && !parseErr) {
      throw new Error('Expected fallback but parsing succeeded');
    }

    console.log(`   ✓ Passed`);
    console.log(`     → Status: ${normalized.status}`);
    console.log(`     → Confidence: ${(normalized.confidence_score * 100).toFixed(0)}%`);
    console.log(`     → ${normalized.suggestion.substring(0, 50)}...`);
    passed++;
  } catch (err) {
    console.log(`   ✗ Failed: ${err.message}`);
    failed++;
  }
  console.log('');
});

console.log('╔════════════════════════════════════════════════════╗');
console.log('║                 TEST SUMMARY                      ║');
console.log(`║ Tests Passed:           ${String(passed).padEnd(30)} ║`);
console.log(`║ Tests Failed:           ${String(failed).padEnd(30)} ║`);
console.log('╚════════════════════════════════════════════════════╝\n');

process.exit(failed > 0 ? 1 : 0);
