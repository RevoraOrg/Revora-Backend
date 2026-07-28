import { app } from './src/index';
import listEndpoints from 'express-list-endpoints';
console.log(listEndpoints(app).map(e => `${e.methods.join(',')} ${e.path}`));
