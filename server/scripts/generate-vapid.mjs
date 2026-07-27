#!/usr/bin/env node
/**
 * Print a fresh VAPID keypair for the operator to paste into the environment.
 * Run with `npm run vapid:generate` from server/.
 *
 * The keys identify this server to the push services. Generate once, keep the
 * private key out of the repo, and never rotate them casually — every existing
 * browser subscription is bound to the public key that created it.
 */
import webpush from 'web-push'

const { publicKey, privateKey } = webpush.generateVAPIDKeys()

console.log('# Add these to the server environment (docker-compose env or .env):')
console.log(`VAPID_PUBLIC_KEY=${publicKey}`)
console.log(`VAPID_PRIVATE_KEY=${privateKey}`)
console.log('VAPID_SUBJECT=mailto:you@example.com')
