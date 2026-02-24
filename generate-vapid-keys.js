#!/usr/bin/env node
/**
 * Generate VAPID keys for Web Push notifications
 * Run this once and add the keys to your .env file
 */

import webpush from 'web-push';

console.log('Generating VAPID keys for Web Push notifications...\n');

const vapidKeys = webpush.generateVAPIDKeys();

console.log('Add these to your .env file:\n');
console.log('# Web Push Notification Configuration (VAPID keys)');
console.log(`VAPID_PUBLIC_KEY=${vapidKeys.publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${vapidKeys.privateKey}`);
console.log('\nIMPORTANT: Keep the private key secret! Do not commit it to version control.');
console.log('\nYou also need to set a contact email for VAPID:');
console.log('VAPID_SUBJECT=mailto:your-email@example.com');
