import React, { useState } from 'react';
import './App.css';

function App() {
  const [count, setCount] = useState(10); // Changed initial value to 10

  return (
    <div className="App">
      <header className="App-header">
        <p>You clicked {count} times</p>
        <button onClick={() => setCount(count + 1)}>
          Click me
        </button>
      </header>
    </div>
  );
}

export default App;