// Help text for the effects command
const EFFECTS_HELP = `
**Available Effects**
• **Audio Effects**:
  \`echo\`, \`robot\`, \`phone\`, \`phaser\`, \`flanger\`, \`tremolo\`, 
  \`vibrato\`, \`chorus\`, \`retroaudio\` (8-bit), \`stutter\`

• **Video Effects**:
  \`vhs\` (retro video), \`oldfilm\`, \`huerotate\`, \`mirror\`, \`flip\`, 
  \`kaleidoscope\`, \`dream\`, \`ascii\`, \`crt\`, \`psychedelic\` (acid),
  \`slowmo\`, \`waves\`, \`pixelate\`

• **General Effects**:
  \`reverse\`, \`speed=[value]\`, \`noise\`, \`glitch\`, \`macroblock\`
  
Example usage:
\`NOW play imperial march {echo=0.8,speed=0.8}\`
\`NOW play theme song {vhs,huerotate}\`
\`NOW quiz {mirror,echo}\`
`;

// Command to show available effects
if (command === 'effects' || command === 'filters') {
  return message.reply(EFFECTS_HELP);
}