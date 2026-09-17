#!/usr/bin/env node
// mm_meta:
//   name: Hello World
//   emoji: 👋
//   language: JavaScript
//   version: 1.0.0
//   source: Yeraze/meshmonitor/examples/auto-responder-scripts/hello.js
/**
 * Simple Hello World script for Auto Responder
 *
 * Environment variables available:
 * - MESSAGE: Full message text
 * - FROM_NODE: Sender node number
 * - PACKET_ID: Message packet ID
 * - TRIGGER: Matched trigger pattern
 * - PARAM_*: Extracted parameters from trigger (e.g., PARAM_name)
 */

const response = {
  response: `Hello ${process.env.PARAM_name || 'World'}! You sent: ${process.env.MESSAGE}`,
  // Optional: Add actions for future extensibility
  // actions: {
  //   notify: false,
  //   log: true
  // }
};

console.log(JSON.stringify(response));
