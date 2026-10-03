const axios = require('axios');
const q = `query { Media(id: 21, type: ANIME) { recommendations(sort: RATING_DESC, perPage: 6) { edges { node { mediaRecommendation { id } } } } } }`;
axios.post('https://graphql.anilist.co', {query: q}).then(r => console.log(JSON.stringify(r.data))).catch(e => console.error(JSON.stringify(e.response.data)));
