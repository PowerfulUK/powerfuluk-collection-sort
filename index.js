import dotenv from 'dotenv'
import express from 'express'
import helmet from 'helmet'
import '@shopify/shopify-api/adapters/node'
import { shopifyApi, ApiVersion } from '@shopify/shopify-api'
import validateWebhook from './helpers'

function getProductQuery(id) {
	return `
        query {
            product(id: "gid://shopify/Product/${id}") {
                id
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

dotenv.config()

const shopify = shopifyApi({
	apiSecretKey: process.env.SHOPIFY_SECRET_KEY,
	apiVersion: ApiVersion.October24,
	isCustomStoreApp: true,
	adminApiAccessToken: process.env.SHOPIFY_ACCESS_TOKEN,
	isEmbeddedApp: false,
	hostName: process.env.SHOPIFY_SHOP,
})

const app = express()
app.use(helmet())
app.use(express.raw({ type: 'application/json' }))

async function handleProductUpdate(id) {
	try {
		const session = shopify.session.customAppSession(
			process.env.SHOPIFY_SHOP
		)
		const client = new shopify.clients.Graphql({ session })
		const response = await client.request(getProductQuery(id))

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

			console.log(JSON.stringify(editResponse.data, null, 2))
		}
	} catch (error) {
		console.error(error)
	}
}

app.post('/webhooks', async (req, res) => {
	try {
		const tokenHeader = req.headers['x-shopify-hmac-sha256']
		const isAuth = validateWebhook(req.body, tokenHeader)
		if (!isAuth) {
			res.sendStatus(401)
			return
		}

		const data = JSON.parse(req.body.toString())
		handleProductUpdate(data.id)

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

// handleProductUpdate('8515057680670')
