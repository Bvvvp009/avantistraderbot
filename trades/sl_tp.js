const MAX_STOPLOSS_PERCENTAGE = 0.74; // Maximum stop-loss percentage
const MAX_TAKEPROFIT_PERCENTAGE = 4.95; // Maximum take-profit percentage
const prices = require('../price/prices.json');
/**
 * Calculate the maximum permissible stop-loss price based on leverage and position type
 * @param {number} currentPrice - Current asset price
 * @param {number} userStopLoss - User's intended stop-loss price
 * @param {number} leverage - Trading leverage
 * @param {boolean} isLong - True for long positions, false for shorts
 * @returns {number} Adjusted stop-loss price
 */
function calculateStopLoss(currentPrice, userStopLoss, leverage, isLong) {
    try {
        // Validate inputs
        if (!currentPrice || !leverage || leverage <= 0) {
            throw new Error('Invalid input parameters');
        }

       console.log(currentPrice,isLong,userStopLoss,leverage)
        if (isLong) {
            const maxStopLossMove = parseFloat(currentPrice) - ((MAX_STOPLOSS_PERCENTAGE*currentPrice)/leverage)
            console.log(maxStopLossMove)
            return userStopLoss>maxStopLossMove ? parseFloat(userStopLoss) : maxStopLossMove
                             
        } else {

            const maxStopLossMove = parseFloat(currentPrice) + parseFloat((MAX_STOPLOSS_PERCENTAGE*currentPrice)/leverage);
           console.log(maxStopLossMove)
            return maxStopLossMove> userStopLoss ? parseFloat(userStopLoss) : maxStopLossMove

        }

    } catch (error) {
        console.error('Error calculating stop-loss:', error);
        throw error;
    }
}

/**
 * Calculate the maximum permissible take-profit price based on leverage and position type
 * @param {number} currentPrice - Current asset price
 * @param {number} userTakeProfit - User's intended take-profit price
 * @param {number} leverage - Trading leverage
 * @param {boolean} isLong - True for long positions, false for shorts
 * @returns {number} Adjusted take-profit price
 */
// function calculateTakeProfit(currentPrice, userTakeProfit, leverage, isLong) {
//     try {
//         // Validate inputs
//         if (!currentPrice || !leverage || leverage <= 0) {
//             throw new Error('Invalid input parameters');
//         }

//         // Calculate maximum allowed take-profit movement based on leverage
//         const maxTakeProfitMove = (currentPrice * MAX_TAKEPROFIT_PERCENTAGE) / leverage;

//         // Calculate maximum allowed take-profit price based on position type
//         let maxTakeProfitPrice;
//         if (isLong) {
//             // For longs, take-profit must be above entry price
//             maxTakeProfitPrice = currentPrice + maxTakeProfitMove;
//         } else {
//             // For shorts, take-profit must be below entry price
//             maxTakeProfitPrice = currentPrice - maxTakeProfitMove;
//         }

//         // If user didn't provide a take-profit, return the maximum allowed
//         if (!userTakeProfit) {
//             return maxTakeProfitPrice;
//         }

//         // For longs, ensure take-profit isn't too high
//         // For shorts, ensure take-profit isn't too low
//         if (isLong) {
//             return Math.min(userTakeProfit, maxTakeProfitPrice);
//         } else {
//             return Math.max(userTakeProfit, maxTakeProfitPrice);
//         }
//     } catch (error) {
//         console.error('Error calculating take-profit:', error);
//         throw error;
//     }
// }

function profit_loss(openPrice,buy,leverage,pairName,margingFee,positionSize){
    let price = prices[pairName];


    

    console.log(`
        - Price: ${price} \n
        -open price ${openPrice} \n
        -Buy - ${buy} \n
        -Leverage - ${leverage} \n
        -Position Size - ${positionSize} \n
        -Margin Fee - ${margingFee}
        ` )
    if(buy){ 
        const total_pnl = (((price-openPrice)/openPrice)*100)*leverage
        console.log("Total PNL:", total_pnl)
        // return profit
    }else{
        const profit = (((parseFloat(openPrice)-parseFloat(currentPrice))/parseFloat(openPrice))*parseInt(leverage))*100
     
        return profit
    }
}


module.exports={calculateStopLoss,profit_loss}