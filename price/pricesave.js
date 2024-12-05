const { PriceServiceConnection } = require('@pythnetwork/price-service-client');
const feedIds = require('../feedIds.json');
const fs = require('fs');

async function fetchPrice(id) {
    const connection = new PriceServiceConnection("https://hermes.pyth.network");
    
    try {
        const currentPrices = await connection.getLatestPriceFeeds([id]);
        
        if (currentPrices && currentPrices.length > 0) {
            // Convert price to string format with 8 decimal precision
            const price = (currentPrices[0].price.price / 10 ** 8).toFixed(8);
            return price;
        }
        
        return null;
    } catch (error) {
        console.error(`Error fetching price for ${id}:`, error);
        return null;
    }
}

async function searchAndStorePrices() {
    const prices = {};

    try {
        // Use Promise.all for concurrent price fetching
        const pricePromises = Object.keys(feedIds).map(async (key) => {
            const id = feedIds[key].id;
            const pair = key; // Use the key as the pair name (e.g., "ETH/USD")
            
            const price = await fetchPrice(id);
            
            if (price !== null) {
                prices[pair] = price;
            }
        });

        // Wait for all price fetches to complete
        await Promise.all(pricePromises);

        // Write prices to JSON file
        fs.writeFileSync('./prices.json', JSON.stringify(prices, null, 2));
        
        console.log('Prices fetched successfully:', prices);
        return prices;
    } catch (error) {
        console.error('Error in price fetching process:', error);
        return {};
    }
}

// Function to start periodic price fetching
function startPriceFetching(intervalMinutes = 1) {
    // Convert minutes to milliseconds
    const intervalMs = intervalMinutes * 60 * 1000 *5;

    // Immediately run the first fetch
    searchAndStorePrices();

    // Set up interval to run every minute
    const intervalId = setInterval(() => {
        searchAndStorePrices();
    }, intervalMs);

    // Optional: Return the interval ID in case you want to stop it later
    return intervalId;
}

// Optional: Graceful shutdown handler
function gracefulShutdown(intervalId) {
    console.log('Stopping price fetching...');
    clearInterval(intervalId);
    process.exit(0);
}

// Start the price fetching
const intervalId = startPriceFetching(1); // 1 minute interval

// Handle process interruption
process.on('SIGINT', () => gracefulShutdown(intervalId));
process.on('SIGTERM', () => gracefulShutdown(intervalId));