import 'dotenv/config';
import { Connection, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import NodeWallet from '@coral-xyz/anchor/dist/cjs/nodewallet';
import { AnchorProvider } from '@coral-xyz/anchor';
import bs58 from 'bs58';
import { PumpFunSDK } from 'pumpdotfun-sdk';
import OpenAI from 'openai';
import fs from 'fs';
import axios from 'axios';
const { RPC, DEPLOYER_KEYPAIR, OPEN_AI_KEY, TOKEN_DEPLOYER_ADDRESS, X_AWS_WAF_TOKEN, X_AWS_PROXY_TOKEN } = process.env;
const BUY_AMOUNT = 0;

interface TaskResponse {
    errorId: number;
    status: string;
    taskId: string;
    errorDescription?: string;
}

interface TaskResultResponse {
    errorId: number;
    status: string;
    taskId: string;
    solution?: {
        token: string;
        type: string;
        userAgent: string;
    };
    errorDescription?: string;
}

const openai = new OpenAI({
    apiKey: OPEN_AI_KEY,
})

const pumpKeypairGen = () => {
    let keypair = new Keypair()
    return keypair
}
const fetchComment = async (tokenAddress: string) => {
    let config = {
        method: 'get',
        maxBodyLength: Infinity,
        url: `https://frontend-api.pump.fun/replies/${tokenAddress}?limit=1000&offset=0`,
    };
    const response = await axios.request(config)
    if (response.status === 200) {
        return response.data
    }
}
const getTokenMetadataByAI = async (content: string) => {
    console.log('Sending metadata request to OpenAI...')
    const response = await openai.chat.completions.create({
        model: 'gpt-4o',
        max_tokens: 100,
        messages: [{
            role: 'system',
            content: `Using the provided schema, create metadata for a token ${content}.

            Make sure the description is fun, slightly silly, and no more than 15 words. At the end of the description, The name should sound lovable and fit within the following schema: 
            
            {
                name: string,
                symbol: string,
                description: string,
            }
            
            Where name can contain a maximum of 32 characters, symbol can contain a maximum of 6 characters, and description can contain a maximum of 100 characters. Symbol should be an abbreviation of name.
            Return only json object

            `
        }],
    })
    console.log('Done')
    const responseMessage = response.choices[0].message.content;

    if (!responseMessage) {
        throw new Error('Response message is null or undefined');
    }

    const mainMessage = JSON.parse(responseMessage.replace("```json\n", "").replace("```", "") || '{}');

    console.dir(mainMessage);

    const prompt = `Create an icon represnting things based on token data (name, symbol and description), but without attaching any text to generated image. Make it look like drawn by kid.
                Name: ${mainMessage.name}
                Symbol: ${mainMessage.symbol}
                Description: ${mainMessage.description}
        `

    console.log('Sending icon request to OpenAI...')
    const tokenIcon = await openai.images.generate({
        prompt,
        n: 1,
        size: '256x256',
        quality: 'standard',
        model: 'dall-e-2',
    })
    console.log('Done')

    const iconImageUrl = tokenIcon.data[0].url

    if (!iconImageUrl) {
        throw new Error('Icon image url not found')
    }

    console.log(`Icon image url: ${iconImageUrl}`);

    const fetchedImage = await fetch(iconImageUrl).then((res) => res.blob());

    fs.writeFile('icon.png', Buffer.from(await fetchedImage.arrayBuffer()), (err) => {
        if (err) {
            console.error('Error saving image:', err);
        } else {
            console.log('Image saved successfully as outputImage.png');
        }
    });
    return {
        ...mainMessage,
        file: fetchedImage,
        twitter: "",
        telegram: "",
        website: "",
    } as {
        name: string,
        symbol: string,
        description: string,
        file: Blob
        twiiter: string,
        telegram: string,
        website: string,
    }
}

const replyMessage = async (text: string) => {
    try {
        const url = "https://client-proxy-server.pump.fun/comment";

        const payload = {
            "text": text,
            "mint": TOKEN_DEPLOYER_ADDRESS,
            "token": ""
        }

        const headers = {
            'sec-ch-ua-platform': '"Windows"',
            'x-aws-proxy-token': X_AWS_PROXY_TOKEN,
            'Referer': 'https://pump.fun/',
            'x-aws-waf-token': X_AWS_WAF_TOKEN,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
            'sec-ch-ua': '"Chromium";v="130", "Google Chrome";v="130", "Not?A_Brand";v="99"',
            'Content-Type': 'application/json',
            'sec-ch-ua-mobile': '?0'
        };

        const response = await axios.post(url, payload, { headers });
        return response.status;
    } catch (err) {
        console.error(`An error occurred: ${err}`);
        return false;
    }
};

const main = async () => {
    console.log('Initializing script...')
    const connection = new Connection(RPC || "")
    const wallet = Keypair.fromSecretKey(bs58.decode(DEPLOYER_KEYPAIR || ""))
    const anchorWallet = new NodeWallet(Keypair.fromSecretKey(bs58.decode(DEPLOYER_KEYPAIR || "")))
    const provider = new AnchorProvider(connection, anchorWallet, { commitment: "finalized" })

    const sdk = new PumpFunSDK(provider)
    let processedComments = new Set();
    while (true) {

        let comments = await fetchComment(TOKEN_DEPLOYER_ADDRESS || "")

        for (let i = 0; i < comments.length; i++) {
            const comment = comments[i];
            if (!processedComments.has(comment.id)) {
                processedComments.add(comment.id);
                const text: string = comment.text;
                console.log(`${text}`)
                if (text.startsWith("/create ")) {
                    const token_content = text.split(' ')[1]
                    console.log('Generating metadata...')
                    const tokenMetadata = await getTokenMetadataByAI(token_content)

                    console.log(`Token metadata ready:`)
                    console.dir(tokenMetadata)

                    const mint = pumpKeypairGen()
                    console.log(`Token mint: ${mint.publicKey}`)

                    console.log('Deploying token...')
                    const createResults = await sdk.createAndBuy(
                        wallet,
                        mint,
                        tokenMetadata,
                        BigInt(BUY_AMOUNT * LAMPORTS_PER_SOL),
                        BigInt(100),
                        {
                            unitLimit: 250000,
                            unitPrice: 1500000,
                        }
                    )

                    if (createResults.success) {
                        await replyMessage(`#${comment.id} Deployed: ${mint.publicKey.toBase58()}`)
                        console.log('Finished')
                        console.log(`https://pump.fun/${mint.publicKey.toBase58()}`)
                    }
                }
            }
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
}

main()
