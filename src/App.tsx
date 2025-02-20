import React, { useState } from 'react';

export default function App() {
  // Change the initial count value to 9999
  const [count, setCount] = useState(9999);

  return (
    <div className="App">
      <header className="App-header">
        <p>
          Count: {count}
        </p>
        <button onClick={() => setCount(count + 1)}>Increment</button>
      </header>
    </div>
  );
}
