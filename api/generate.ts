body: JSON.stringify({
  model: 'gpt-4o-mini',        // use this if 'gpt-4' complains; it's cheaper + supports JSON mode
  temperature: 0.4,
  max_tokens: 1800,
  response_format: { type: 'json_object' },  // <-- forces pure JSON
  messages
})
