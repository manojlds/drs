import express from 'express';
import { Pool } from 'pg';

// Hardcoded credentials - security issue
const DB_PASSWORD = 'superSecret123!';
const API_KEY = 'sk-1234567890abcdef';

const app = express();
const pool = new Pool({
  host: 'localhost',
  password: DB_PASSWORD,
});

// SQL Injection vulnerability
app.get('/user/:id', async (req, res) => {
  const userId = req.params.id;
  // Direct string concatenation in SQL query
  const query = `SELECT * FROM users WHERE id = ${userId}`;
  const result = await pool.query(query);
  res.json(result.rows);
});

// Missing error handling
app.post('/data', async (req, res) => {
  const data = await fetch('https://api.example.com/data');
  const json = await data.json();
  res.json(json);
});

// Performance issue - inefficient nested loops
function findDuplicates(arr1: number[], arr2: number[]): number[] {
  const dups = [];
  for (let i = 0; i < arr1.length; i++) {
    for (let j = 0; j < arr2.length; j++) {
      if (arr1[i] === arr2[j]) {
        dups.push(arr1[i]);
      }
    }
  }
  return dups;
}

// Poor naming and console.log left in code
function p(x: any) {
  console.log('Processing:', x);
  let y = x * 2;
  console.log('Result:', y);
  return y;
}

// Type safety issues
function calculateTotal(items: any): number {
  let total = 0;
  for (const item of items) {
    total += item.price * item.quantity;
  }
  return total;
}

// Unused variables
const UNUSED_CONSTANT = 'This is never used';
let unusedVariable = 42;

// Missing input validation
app.delete('/user/:id', async (req, res) => {
  const userId = req.params.id;
  await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
  res.json({ success: true });
});

// Race condition potential
let counter = 0;
app.get('/increment', (req, res) => {
  counter++;
  setTimeout(() => {
    counter--;
  }, 1000);
  res.json({ counter });
});

// Missing authentication
app.post('/admin/settings', (req, res) => {
  // No authentication check
  const settings = req.body;
  // Apply settings...
  res.json({ message: 'Settings updated' });
});

export { app, findDuplicates, p, calculateTotal };
