import { useState } from 'react';
import './App.css';

function App() {
  // Change the initial count value to 99999
  const [count, setCount] = useState(99999);

  return (
    <div className='App'>
      <header className='App-header'>
        <h1>Counter: {count}</h1>
        <button onClick={() => setCount(count + 1)}>Increment</button>
      </header>
    </div>
  );
}

export default App;
