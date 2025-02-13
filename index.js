import dotenv from 'dotenv'
import express from 'express'
import helmet from 'helmet'
import '@shopify/shopify-api/adapters/node'
import { shopifyApi, ApiVersion } from '@shopify/shopify-api'
import { validateWebhook } from './helpers/index.js'

dotenv.config()

function getRelatedVariantsQuery(ids) {
	return `
        query {
            productVariants(first: 100, query: "${ids
				.map((id) => `id:${id}`)
				.join(' OR ')}") {
                edges {
                    node {
                        product {
                            id
                        }
                    }
                }
            }
        }
        `
}

function getProductQuery(id) {
	return `
        query {
            product(id: "gid://shopify/Product/${id}") {
                id
                relatedProducts: metafield(namespace: "custom", key: "related_products_from_volo") {
                    value
                }
                collections(first: 10, query: "collection_type:custom") {
                    edges {
                        node {
                            id
                            products(first: 250, sortKey: MANUAL) {
                                edges {
                                    node {
                                        id
                                        order: metafield(namespace: "custom", key: "product_order") {
                                            value
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    `
}

const METAFIELD_M = `
        mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
            metafieldsSet(metafields: $metafields) {
                userErrors {
                    field
                    message
                }
            }
        }
    `

const REORDER_Q = `
    mutation collectionReorderProducts($id: ID!, $moves: [MoveInput!]!) {
        collectionReorderProducts(id: $id, moves: $moves) {
            job {
                id
            }
            userErrors {
                field
                message
            }
        }
    }
`

const app = express()
app.use(helmet())
app.use(express.raw({ type: 'application/json' }))

setUpSubscriptions()

async function setUpSubscriptions() {
	const shops = ['4ee229.myshopify.com', 'trade4x4.myshopify.com']
	for (const shop of shops) {
		const client = getClient(shop)

		const countRes = await client.request(`
            query {
                webhookSubscriptions(first: 10) {
                    edges {
                        node {
                            id
                            topic
                            endpoint {
                                __typename
                                ... on WebhookHttpEndpoint {
                                    callbackUrl
                                }
                            }
                        }
                    }
                }
            }
        `)

		const webhookNodes = countRes.data.webhookSubscriptions.edges.map(
			({ node }) => node
		)

		console.log(JSON.stringify(webhookNodes, null, 2))

		for (const webhookNode of webhookNodes) {
			await client.request(`
                mutation {
                    webhookSubscriptionDelete(id: "${webhookNode.id}") {
                        deletedWebhookSubscriptionId
                    }
                }
            `)
		}

		const res = await client.request(
			`
            mutation webhookSubscriptionCreate($topic: WebhookSubscriptionTopic!, $webhookSubscription: WebhookSubscriptionInput!) {
                webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription) {
                    userErrors {
                        field
                        message
                    }
                }
            }`,
			{
				variables: {
					topic: 'PRODUCTS_UPDATE',
					webhookSubscription: {
						callbackUrl:
							process.env.NODE_ENV === 'production'
								? `https://${process.env.FLY_APP_NAME}.fly.dev/webhooks-filtered`
								: `${process.env.HOST}/webhooks-filtered`,
						format: 'JSON',
						filter: 'metafields.key:product_order OR metafields.key:related_products_from_volo',
						includeFields: ['id', 'metafields'],
						metafieldNamespaces: ['custom'],
					},
				},
			}
		)

		if (res.data.webhookSubscriptionCreate.userErrors.length) {
			console.error(
				JSON.stringify(res.data.webhookSubscriptionCreate.userErrors)
			)
		}
	}
}

function getShopify(shop) {
	let apiSecretKey
	let adminApiAccessToken

	switch (shop) {
		case '4ee229.myshopify.com':
			apiSecretKey = process.env.SHOPIFY_SECRET_KEY_PUK
			adminApiAccessToken = process.env.SHOPIFY_ACCESS_TOKEN_PUK
			break
		case 'trade4x4.myshopify.com':
			apiSecretKey = process.env.SHOPIFY_SECRET_KEY_TRADE
			adminApiAccessToken = process.env.SHOPIFY_ACCESS_TOKEN_TRADE
			break
	}

	const shopify = shopifyApi({
		apiSecretKey,
		apiVersion: ApiVersion.October24,
		isCustomStoreApp: true,
		adminApiAccessToken,
		isEmbeddedApp: false,
		hostName: shop,
		logger: {
			level: 0,
		},
	})

	return shopify
}

function getClient(shop) {
	const shopify = getShopify(shop)

	const session = shopify.session.customAppSession(shop)
	const client = new shopify.clients.Graphql({ session })

	return client
}

async function handleProductUpdate(id, shop) {
	console.log(`Handling product update for ${id} in ${shop}`)
	try {
		const client = getClient(shop)
		const response = await client.request(getProductQuery(id))

		// Update collections order
		for (const collection of response.data.product.collections.edges) {
			const moves = [...collection.node.products.edges]
				.sort(
					(a, b) =>
						Number(a.node.order?.value || 0) -
						Number(b.node.order?.value || 0)
				)
				.map((product, index) => ({
					id: product.node.id,
					newPosition: String(index + 1),
				}))

			const prevOrder = collection.node.products.edges.map(
				(product) => product.node.id
			)
			const newOrder = moves.map((move) => move.id)

			if (JSON.stringify(prevOrder) === JSON.stringify(newOrder)) {
				continue
			}

			const editResponse = await client.request(REORDER_Q, {
				variables: {
					id: collection.node.id,
					moves,
				},
			})

			if (editResponse.data.collectionReorderProducts.userErrors.length) {
				console.error(
					JSON.stringify(
						editResponse.data.collectionReorderProducts.userErrors
					)
				)
			}
		}

		// Update related products
		if (
			response.data.product.relatedProducts?.value &&
			shop === '4ee229.myshopify.com'
		) {
			const relatedVariantIds = JSON.parse(
				response.data.product.relatedProducts.value
			)
				.map((id) => id.split(','))
				.flat()

			const query = getRelatedVariantsQuery(relatedVariantIds)
			const relatedVariants = await client.request(query)

			const relatedProductIds =
				relatedVariants.data.productVariants.edges.map(
					({ node }) => node.product.id
				)

			const metafield = {
				key: 'related_products',
				namespace: 'shopify--discovery--product_recommendation',
				ownerId: response.data.product.id,
				type: 'list.product_reference',
				value: JSON.stringify(relatedProductIds),
			}

			const metafields = [metafield]

			const metafieldResponse = await client.request(METAFIELD_M, {
				variables: {
					metafields,
				},
			})

			if (metafieldResponse.data.metafieldsSet.userErrors.length) {
				console.error(
					JSON.stringify(
						metafieldResponse.data.metafieldsSet.userErrors
					)
				)
			}
		}
	} catch (error) {
		console.error(error)
	}
}

// app.post('/webhooks', async (req, res) => {
// 	try {
// 		const tokenHeader = req.headers['x-shopify-hmac-sha256']
// 		const shop = req.headers['x-shopify-shop-domain']
// 		let sig

// 		switch (shop) {
// 			case '4ee229.myshopify.com':
// 				sig = process.env.SHOPIFY_WEBHOOK_AUTH_PUK
// 				break
// 			case 'trade4x4.myshopify.com':
// 				sig = process.env.SHOPIFY_WEBHOOK_AUTH_TRADE
// 				break
// 		}

// 		const isAuth = validateWebhook(req.body, tokenHeader, sig)
// 		if (!isAuth) {
// 			res.sendStatus(401)
// 			return
// 		}

// 		const data = JSON.parse(req.body.toString())
// 		handleProductUpdate(data.id, shop)

// 		res.sendStatus(200)
// 	} catch (error) {
// 		console.error(error)
// 		res.sendStatus(500)
// 	}
// })

app.post('/webhooks-filtered', async (req, res) => {
	try {
		const shop = req.headers['x-shopify-shop-domain']

		const { webhooks } = getShopify(shop)
		const { valid, topic, domain } = await webhooks.validate({
			rawBody: req.body, // is a string
			rawRequest: req,
			rawResponse: res,
		})

		if (!valid) {
			res.send(400)
			return
		}

		const data = JSON.parse(req.body.toString())

		handleProductUpdate(data.id, shop)

		res.sendStatus(200)
	} catch (error) {
		console.error(error)
		res.sendStatus(500)
	}
})

const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
	console.log(`Server is running on port ${PORT}`)
})
