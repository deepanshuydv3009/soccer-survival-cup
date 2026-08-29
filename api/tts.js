export default async function handler(request, response) {
  const text = String(request.query?.text || '').trim().slice(0, 240);

  if (!text) {
    response.status(400).json({ error: 'text is required' });
    return;
  }

  const ttsUrl = new URL('https://translate.google.com/translate_tts');
  ttsUrl.searchParams.set('ie', 'UTF-8');
  ttsUrl.searchParams.set('client', 'tw-ob');
  ttsUrl.searchParams.set('tl', 'en-US');
  ttsUrl.searchParams.set('q', text);

  try {
    const ttsResponse = await fetch(ttsUrl);
    if (!ttsResponse.ok) {
      response.status(502).json({ error: 'TTS provider unavailable' });
      return;
    }

    const audio = Buffer.from(await ttsResponse.arrayBuffer());
    response.setHeader('Content-Type', 'audio/mpeg');
    response.setHeader('Cache-Control', 'public, max-age=3600');
    response.status(200).send(audio);
  } catch (error) {
    response.status(502).json({ error: 'TTS request failed' });
  }
}
