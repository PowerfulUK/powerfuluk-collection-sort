import crypto from 'crypto'

export function validateWebhook(body, hmacHeader, sig) {
	const hmac = crypto.createHmac('sha256', sig)
	hmac.update(body)
	const computedHmac = hmac.digest('base64')

	const isAuth = crypto.timingSafeEqual(
		Buffer.from(computedHmac),
		Buffer.from(hmacHeader)
	)

	if (!isAuth) {
		return false
	}

	return true
}
