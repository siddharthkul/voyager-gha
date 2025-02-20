import React, { useState } from 'react';
import './App.css';

function App() {
  const [count, setCount] = useState(100); // Changed initial value to 100

  return (
    <div className="App">
      <h1>Hello Vite React TS</h1>
      <p>You clicked {count} times</p>
      <button onClick={() => setCount(count + 1)}>
        Click me
      </button>
    </div>
  );
}

export default App;